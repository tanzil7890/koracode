// Engine-side tracing: the container log names the responder per turn and
// records proposal outcomes — the mirror of the control plane's
// `authoring.engine` lines. Silent when no sink is injected, and never
// carries turn content.

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LLMResponder } from "../src/llm-responder"
import { type EngineTrace, WorkflowServe } from "../src/serve"

const AUTH = { authorization: `Bearer ${"t".repeat(32)}` }

interface Captured {
  event: string
  fields: Record<string, unknown>
}

function collector(): { events: Captured[]; trace: EngineTrace } {
  const events: Captured[] = []
  return { events, trace: (event, fields) => void events.push({ event, fields }) }
}

function req(method: string, path: string, body?: unknown): Request {
  return new Request(`http://engine.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...AUTH },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function createSession(serve: WorkflowServe): Promise<string> {
  const response = await serve.fetch(
    req("POST", "/sessions", { product_session_id: "ps-1", agent_id: "agent-1", protocol_version: "v1", profile: "managed-workflow" }),
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { session_id: string }).session_id
}

async function waitTerminal(events: Captured[], turnId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (events.some((e) => e.fields["turn_id"] === turnId && e.event !== "turn_accepted")) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

describe("WorkflowServe trace", () => {
  test("names the responder on accept and completion, without any turn content", async () => {
    const sink = collector()
    const serve = new WorkflowServe({ workspaceRoot: mkdtempSync(join(tmpdir(), "kcw-trace-")), trace: sink.trace })
    const sid = await createSession(serve)
    const submit = await serve.fetch(
      req("POST", `/sessions/${sid}/turns`, { turn_id: "turn-1", epoch: 1, content: "top secret payload", history: [{ role: "user", content: "earlier" }] }),
    )
    expect(submit.status).toBe(200)
    await waitTerminal(sink.events, "turn-1")

    expect(sink.events.map((e) => e.event)).toEqual(["turn_accepted", "turn_completed"])
    const [accepted, completed] = sink.events
    expect(accepted!.fields["responder"]).toBe("drill")
    expect(accepted!.fields["session"]).toBe("ps-1")
    expect(accepted!.fields["agent"]).toBe("agent-1")
    expect(accepted!.fields["history_messages"]).toBe(1)
    expect(accepted!.fields["callback_tokens"]).toBe(0)
    expect(completed!.fields["responder"]).toBe("drill")
    expect(typeof completed!.fields["duration_ms"]).toBe("number")
    expect(typeof completed!.fields["total_tokens"]).toBe("number")
    const serialized = JSON.stringify(sink.events)
    expect(serialized).not.toContain("top secret")
    expect(serialized).not.toContain("earlier")
  })

  test("replays and stale epochs are traced with their reason", async () => {
    const sink = collector()
    const serve = new WorkflowServe({ workspaceRoot: mkdtempSync(join(tmpdir(), "kcw-trace-")), trace: sink.trace })
    const sid = await createSession(serve)
    const body = { turn_id: "turn-1", epoch: 2, content: "x", history: [] }
    await serve.fetch(req("POST", `/sessions/${sid}/turns`, body))
    await waitTerminal(sink.events, "turn-1")
    await serve.fetch(req("POST", `/sessions/${sid}/turns`, body)) // idempotent resubmit
    const refused = await serve.fetch(req("POST", `/sessions/${sid}/turns`, { turn_id: "turn-2", epoch: 1, content: "x", history: [] }))
    expect(refused.status).toBe(409)

    const replayed = sink.events.find((e) => e.event === "turn_replayed")!
    expect(replayed.fields["turn_id"]).toBe("turn-1")
    expect(replayed.fields["state"]).toBe("completed")
    const stale = sink.events.find((e) => e.event === "turn_refused")!
    expect(stale.fields).toMatchObject({ turn_id: "turn-2", reason: "stale_epoch", epoch: 1, session_epoch: 2 })
  })

  test("a responder failure is traced with the error type only", async () => {
    const sink = collector()
    const serve = new WorkflowServe({
      workspaceRoot: mkdtempSync(join(tmpdir(), "kcw-trace-")),
      trace: sink.trace,
      responder: {
        name: "exploding",
        async respond() {
          throw new TypeError("model said: the password is hunter2")
        },
      },
    })
    const sid = await createSession(serve)
    await serve.fetch(req("POST", `/sessions/${sid}/turns`, { turn_id: "turn-1", epoch: 1, content: "x", history: [] }))
    await waitTerminal(sink.events, "turn-1")
    const failed = sink.events.find((e) => e.event === "turn_failed")!
    expect(failed.fields["responder"]).toBe("exploding")
    expect(failed.fields["error"]).toBe("TypeError")
    expect(JSON.stringify(failed)).not.toContain("hunter2")
  })

  test("is silent when no sink is configured", async () => {
    const serve = new WorkflowServe({ workspaceRoot: mkdtempSync(join(tmpdir(), "kcw-trace-")) })
    const sid = await createSession(serve)
    const response = await serve.fetch(req("POST", `/sessions/${sid}/turns`, { turn_id: "turn-1", epoch: 1, content: "x", history: [] }))
    expect(response.status).toBe(200)
  })
})

// ---------------------------------------------------------------- responder

const POLICY = { allowedOrigins: ["https://api.openai.test", "https://kora.internal:8000"] }

function modelMessage(content: string | null, toolCalls?: { name: string; args: Record<string, unknown> }[]) {
  return Response.json({
    choices: [
      {
        message: {
          role: "assistant",
          content,
          ...(toolCalls
            ? {
                tool_calls: toolCalls.map((call, index) => ({
                  id: `call_${index}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                })),
              }
            : {}),
        },
      },
    ],
    usage: { total_tokens: 50 },
  })
}

const HEAD_GRAPH = {
  version: 3,
  name: "Base",
  entry: "n1",
  variables: [],
  nodes: [
    { id: "n1", type: "agent", name: "Step one", instruction: "Open the page", position: { x: 0, y: 0 } },
    { id: "ok", type: "success", position: { x: 300, y: 0 } },
    { id: "err", type: "error", position: { x: 300, y: 200 } },
  ],
  edges: [
    { id: "e1", from: "n1", to: "ok", when: "success" },
    { id: "e2", from: "n1", to: "err", when: "error" },
  ],
}

describe("LLMResponder trace", () => {
  test("records denied tools, the proposal outcome, and the loop summary", async () => {
    const sink = collector()
    let round = 0
    const rounds = [
      () => modelMessage(null, [{ name: "bash", args: { command: "id" } }]),
      () => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "agent-1" } }]),
      () =>
        modelMessage(null, [
          {
            name: "workflow_propose",
            args: { agent_id: "agent-1", base_generation: 3, base_hash: "sha256:h", candidate_graph: { ...HEAD_GRAPH, name: "Renamed" }, idempotency_key: "t1" },
          },
        ]),
      () => modelMessage("done"),
    ]
    const responder = new LLMResponder({
      apiKey: "sk-test",
      model: "gpt-test",
      modelOrigin: "https://api.openai.test",
      policy: POLICY,
      trace: sink.trace,
      fetchImpl: (async (url: any) => {
        const target = String(url)
        if (target.startsWith("https://kora.internal")) {
          if (target.endsWith("/proposals/validate")) return Response.json({ validation: { ok: true, issues: [] }, risk_level: "low" })
          if (target.endsWith("/proposals")) return Response.json({ change_set_id: "cs-1", status: "proposed", risk_level: "low" })
          return Response.json({ generation: 3, content_hash: "sha256:h", graph: HEAD_GRAPH })
        }
        const handler = rounds[Math.min(round, rounds.length - 1)]!
        round += 1
        return handler()
      }) as typeof fetch,
    })
    await responder.respond({
      turnId: "t1",
      epoch: 1,
      content: "rename it",
      history: [],
      callback: { gatewayUrl: "https://kora.internal:8000", agentId: "agent-1", tokens: ["a", "b", "c", "d"] },
    })
    expect(responder.name).toBe("llm")
    expect(sink.events.map((e) => e.event)).toEqual(["tool_denied", "proposal_created", "responder_done"])
    expect(sink.events[0]!.fields).toMatchObject({ turn_id: "t1", tool: "bash", error: "ToolDeniedError" })
    expect(sink.events[1]!.fields).toMatchObject({ turn_id: "t1", change_set_id: "cs-1", status: "proposed", risk_level: "low", repairs: 0 })
    expect(sink.events[2]!.fields).toMatchObject({ turn_id: "t1", model: "gpt-test", proposed: true, tool_calls: 3, tokens_left: 1 })
    expect(JSON.stringify(sink.events)).not.toContain("rename it")
  })

  test("a refused candidate is traced as not created with its reason", async () => {
    const sink = collector()
    let round = 0
    const rounds = [
      () =>
        modelMessage(null, [
          {
            name: "workflow_propose",
            args: {
              agent_id: "agent-1",
              base_generation: 3,
              base_hash: "sha256:h",
              candidate_graph: { ...HEAD_GRAPH, edges: [{ id: "e1", from: "n1", to: "ghost", when: "success" }] },
              idempotency_key: "t1",
            },
          },
        ]),
      () => modelMessage("could not"),
      () => modelMessage("no change"),
    ]
    const responder = new LLMResponder({
      apiKey: "sk-test",
      model: "gpt-test",
      modelOrigin: "https://api.openai.test",
      policy: POLICY,
      trace: sink.trace,
      fetchImpl: (async (url: any) => {
        if (String(url).startsWith("https://kora.internal")) return Response.json({ generation: 3, content_hash: "sha256:h", graph: HEAD_GRAPH })
        const handler = rounds[Math.min(round, rounds.length - 1)]!
        round += 1
        return handler()
      }) as typeof fetch,
    })
    await responder.respond({
      turnId: "t1",
      epoch: 1,
      content: "x",
      history: [],
      callback: { gatewayUrl: "https://kora.internal:8000", agentId: "agent-1", tokens: ["a", "b"] },
    })
    const notCreated = sink.events.find((e) => e.event === "proposal_not_created")!
    expect(notCreated.fields).toMatchObject({ turn_id: "t1", reason: "engine_precheck_failed", attempt: 1 })
    expect((notCreated.fields["issues"] as number) >= 1).toBe(true)
    expect(sink.events.some((e) => e.event === "completion_nudge")).toBe(true)
    const done = sink.events.find((e) => e.event === "responder_done")!
    expect(done.fields["proposed"]).toBe(false)
  })
})
