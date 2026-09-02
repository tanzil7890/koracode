// Phase 12.8 step 4 responder tests: run tools are registered ONLY when the
// turn's callback grants the 'run' feature; agent_id stays pinned while run
// ids pass through untouched; run start/control/wait are traced; a gateway
// error code (NO_PUBLISHED_VERSION) reaches the model as data; and serve.ts
// parses body.callback.features with the legacy ['propose'] default.

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LLMResponder, runProcedure } from "../src/llm-responder"
import { DEFAULT_CALLBACK_FEATURES, WorkflowServe, callbackFeatures, type TurnRequest } from "../src/serve"
import { WORKFLOW_PROPOSAL_TOOLS, WORKFLOW_READ_TOOLS, WORKFLOW_RUN_TOOLS } from "../src/tools"

const POLICY = { allowedOrigins: ["https://api.openai.test", "https://kora.internal:8000"] }
const BASE = "https://kora.internal:8000/internal/kora/v1"

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

interface ModelRequest {
  messages: { role: string; content: string | null }[]
  tools?: { function: { name: string } }[]
}

interface Seen {
  gateway: { url: string; method: string; body: unknown; token: string }[]
  model: ModelRequest[]
  events: { event: string; fields: Record<string, unknown> }[]
  sleeps: number[]
}

function responderWith(handlers: {
  model: (() => Response)[]
  gateway?: (url: string, call: number, body: unknown) => Response
}) {
  const seen: Seen = { gateway: [], model: [], events: [], sleeps: [] }
  let round = 0
  const responder = new LLMResponder({
    apiKey: "sk-test",
    model: "gpt-test",
    modelOrigin: "https://api.openai.test",
    policy: POLICY,
    trace: (event, fields) => void seen.events.push({ event, fields }),
    sleep: async (ms) => void seen.sleeps.push(ms),
    fetchImpl: (async (url: any, init?: RequestInit) => {
      const target = String(url)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (target.startsWith("https://kora.internal")) {
        const token = (new Headers(init?.headers).get("authorization") ?? "").replace("Bearer ", "")
        seen.gateway.push({ url: target, method: init?.method ?? "GET", body, token })
        return handlers.gateway ? handlers.gateway(target, seen.gateway.length, body) : Response.json({})
      }
      seen.model.push(body as ModelRequest)
      const handler = handlers.model[Math.min(round, handlers.model.length - 1)]!
      round += 1
      return handler()
    }) as typeof fetch,
  })
  return { responder, seen }
}

const TOKENS = ["tok-1", "tok-2", "tok-3", "tok-4", "tok-5", "tok-6", "tok-7", "tok-8"]
const LEGACY_CALLBACK = { gatewayUrl: "https://kora.internal:8000", agentId: "agent-1", tokens: TOKENS }
const RUN_CALLBACK = { ...LEGACY_CALLBACK, features: ["run"] }

const ids = (tools: readonly { id: string }[]) => tools.map((tool) => tool.id)
const registeredTools = (seen: Seen) => (seen.model[0]?.tools ?? []).map((tool) => tool.function.name)
const systemPrompt = (seen: Seen) => seen.model[0]!.messages[0]!.content ?? ""
const event = (seen: Seen, name: string) => seen.events.find((entry) => entry.event === name)

function lastToolResult(seen: Seen): Record<string, unknown> {
  const request = seen.model[seen.model.length - 1]!
  const tool = [...request.messages].reverse().find((message) => message.role === "tool")!
  return JSON.parse(tool.content ?? "{}") as Record<string, unknown>
}

function resource(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-77",
    agent_id: "agent-1",
    status: "running",
    definition: { source: "published", version_number: 3, definition_digest: "sha256:d", labelled_non_production: false },
    control_state: { cancel_requested: false, pause_requested: false, paused_at: null },
    legal_controls: ["pause", "cancel"],
    waiting_request: null,
    ...overrides,
  }
}

function turn(callback: TurnRequest["callback"], content = "please run the workflow"): TurnRequest {
  return { turnId: "t1", epoch: 1, content, history: [], callback }
}

describe("feature-gated tool registration", () => {
  test("features ['run'] registers read + run tools (no proposal tools) and adds the RUN PROCEDURE", async () => {
    const { responder, seen } = responderWith({ model: [() => modelMessage("ok")] })
    await responder.respond(turn(RUN_CALLBACK))
    expect(registeredTools(seen)).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_RUN_TOOLS]))
    const prompt = systemPrompt(seen)
    expect(prompt).toContain("RUN PROCEDURE")
    expect(prompt).toContain("NO_PUBLISHED_VERSION")
    expect(prompt).toContain("idempotency_key 't1:run'")
    expect(prompt).toContain("The workflow agent id is agent-1.")
    expect(prompt).not.toContain("WORKFLOW-CHANGE PROCEDURE")
    expect(prompt).toContain("cannot change the workflow definition")
  })

  test("a callback WITHOUT features keeps the legacy proposal surface (backward compatible)", async () => {
    const { responder, seen } = responderWith({ model: [() => modelMessage("ok")] })
    await responder.respond(turn(LEGACY_CALLBACK, "rename it"))
    expect(registeredTools(seen)).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS]))
    const prompt = systemPrompt(seen)
    expect(prompt).toContain("WORKFLOW-CHANGE PROCEDURE")
    expect(prompt).not.toContain("RUN PROCEDURE")
    expect(event(seen, "responder_done")!.fields["features"]).toEqual(["propose"])
  })

  test("features ['propose','run'] registers everything with both procedures", async () => {
    const { responder, seen } = responderWith({ model: [() => modelMessage("ok")] })
    await responder.respond(turn({ ...LEGACY_CALLBACK, features: ["propose", "run"] }))
    expect(registeredTools(seen)).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS, ...WORKFLOW_RUN_TOOLS]))
    expect(systemPrompt(seen)).toContain("WORKFLOW-CHANGE PROCEDURE")
    expect(systemPrompt(seen)).toContain("RUN PROCEDURE")
  })

  test("features [] registers the read tools only, under the read-only prompt", async () => {
    const { responder, seen } = responderWith({ model: [() => modelMessage("ok")] })
    await responder.respond(turn({ ...LEGACY_CALLBACK, features: [] }))
    expect(registeredTools(seen)).toEqual(ids(WORKFLOW_READ_TOOLS))
    const prompt = systemPrompt(seen)
    expect(prompt).toContain("You cannot change anything")
    expect(prompt).not.toContain("RUN PROCEDURE")
    expect(prompt).not.toContain("WORKFLOW-CHANGE PROCEDURE")
  })

  test("runProcedure derives every id from the turn id and states the control semantics", () => {
    const text = runProcedure("turn-9")
    expect(text).toContain("'turn-9:run'")
    expect(text).toContain("'turn-9:<command>'")
    expect(text).toContain("'turn-9:input'")
    expect(text).toContain("source defaults to 'published'")
    expect(text).toContain("NEVER say a run is paused, resumed, or cancelled unless")
    expect(text).toContain("'unsupported' means the runtime cannot do it")
    expect(text).toContain("@run <id>")
    expect(text).toContain("never modify the running definition")
  })
})

describe("run tool dispatch", () => {
  test("start → wait → reply: agent pinned, turn linked, run id untouched, one token per call, traced", async () => {
    const polls = ["running", "completed"]
    let poll = 0
    const { responder, seen } = responderWith({
      model: [
        () =>
          modelMessage(null, [
            { name: "workflow_run_start", args: { agent_id: "someone-elses-agent", idempotency_key: "t1:run" } },
          ]),
        () => modelMessage(null, [{ name: "workflow_run_wait", args: { run_id: "run-77", max_polls: 2, interval_ms: 1000 } }]),
        () => modelMessage("Started run run-77 from the published version; status completed; legal_controls: []."),
      ],
      gateway: (url) => {
        if (url.endsWith("/workflows/agent-1/runs")) return Response.json(resource({ status: "queued" }), { status: 202 })
        return Response.json(resource({ status: polls[poll++], legal_controls: [] }))
      },
    })
    const result = await responder.respond(turn(RUN_CALLBACK))
    expect(result.reply).toContain("run-77")

    expect(seen.gateway[0]).toMatchObject({ url: `${BASE}/workflows/agent-1/runs`, method: "POST" })
    expect(seen.gateway[0]!.body).toEqual({ idempotency_key: "t1:run", source: "published", turn_id: "t1" })
    expect(seen.gateway.slice(1).map((call) => call.url)).toEqual([`${BASE}/runs/run-77/resource`, `${BASE}/runs/run-77/resource`])
    expect(seen.gateway.map((call) => call.token)).toEqual(["tok-1", "tok-2", "tok-3"]) // one one-use token per call
    expect(seen.sleeps).toEqual([1000]) // injected sleep, only between the two polls

    const waited = lastToolResult(seen)
    expect(waited).toMatchObject({ reason: "terminal", polls: 2, waited_ms: 1000 })
    expect((waited["resource"] as Record<string, unknown>)["status"]).toBe("completed")

    expect(event(seen, "run_started")!.fields).toEqual({ turn_id: "t1", run_id: "run-77", status: "queued", source: "published" })
    expect(event(seen, "run_wait")!.fields).toEqual({ turn_id: "t1", run_id: "run-77", polls: 2, reason: "terminal" })
    expect(event(seen, "responder_done")!.fields).toMatchObject({ runs_started: 1, features: ["run"], tool_calls: 2, tokens_left: 5 })
    expect(JSON.stringify(seen.events)).not.toContain("please run the workflow") // traces never carry turn content
  })

  test("a control result is passed to the model literally and traced with its effective_status", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_run_control", args: { run_id: "run-77", command: "pause", command_id: "t1:pause" } }]),
        () => modelMessage("Pause requested; effective_status is 'pending', so the run is not paused yet."),
      ],
      gateway: () =>
        Response.json(
          { command_id: "t1:pause", command: "pause", request_status: "accepted", effective_status: "pending", run_status: "running", reason: null, replayed: false },
          { status: 202 },
        ),
    })
    await responder.respond(turn(RUN_CALLBACK, "pause @run run-77"))
    expect(seen.gateway[0]).toMatchObject({ url: `${BASE}/runs/run-77/controls`, method: "POST" })
    expect(seen.gateway[0]!.body).toEqual({ command: "pause", command_id: "t1:pause" })
    expect(lastToolResult(seen)).toMatchObject({ request_status: "accepted", effective_status: "pending" })
    expect(event(seen, "run_control")!.fields).toEqual({ turn_id: "t1", run_id: "run-77", command: "pause", effective_status: "pending" })
  })

  test("submit_input, capabilities, list, and get hit their exact paths with run ids untouched", async () => {
    const { responder, seen } = responderWith({
      model: [
        () =>
          modelMessage(null, [
            { name: "workflow_run_submit_input", args: { run_id: "run-77", input_id: "t1:input", request_id: "req-1", payload: { otp: "123456" } } },
            { name: "workflow_run_capabilities", args: { run_id: "run-77" } },
            { name: "workflow_run_list", args: { agent_id: "wrong-agent", limit: 3 } },
            { name: "workflow_run_get", args: { run_id: "run-78" } },
          ]),
        () => modelMessage("done"),
      ],
      gateway: (url) => {
        if (url.endsWith("/inputs")) {
          return Response.json({ input_id: "t1:input", request_id: "req-1", run_id: "run-77", status: "accepted", answered_at: "now", replayed: false }, { status: 202 })
        }
        if (url.endsWith("/capabilities")) {
          return Response.json({ protocol_version: "v1", run_id: "run-77", kind: "backend_capabilities", capabilities: { backend: "kora", supports_pause: true } })
        }
        if (url.includes("/workflows/")) return Response.json({ items: [resource()], next_cursor: null })
        return Response.json(resource({ run_id: "run-78" }))
      },
    })
    await responder.respond(turn(RUN_CALLBACK, "answer the OTP prompt"))
    expect(seen.gateway.map((call) => `${call.method} ${call.url}`)).toEqual([
      `POST ${BASE}/runs/run-77/inputs`,
      `GET ${BASE}/runs/run-77/capabilities`,
      `GET ${BASE}/workflows/agent-1/runs?limit=3`, // agent pinned to the turn's agent
      `GET ${BASE}/runs/run-78/resource`,
    ])
    expect(seen.gateway[0]!.body).toEqual({ input_id: "t1:input", request_id: "req-1", payload: { otp: "123456" } })
  })

  test("a NO_PUBLISHED_VERSION gateway error reaches the model as data with its code, traced, and no run is recorded", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_run_start", args: { agent_id: "agent-1", idempotency_key: "t1:run" } }]),
        () => modelMessage("There is no published version yet. Shall I run the current draft (draft_snapshot) instead?"),
      ],
      gateway: () => Response.json({ detail: { code: "NO_PUBLISHED_VERSION", message: "workflow has no published version" } }, { status: 409 }),
    })
    const result = await responder.respond(turn(RUN_CALLBACK))
    expect(result.reply).toContain("draft_snapshot")
    const payload = lastToolResult(seen)
    expect(payload["code"]).toBe("NO_PUBLISHED_VERSION")
    expect(payload["status"]).toBe(409)
    expect(payload["message"]).toBe("workflow has no published version")
    expect(String(payload["error"])).toContain("ControlPlaneError")
    expect(event(seen, "tool_failed")!.fields).toMatchObject({ turn_id: "t1", tool: "workflow_run_start", error: "ControlPlaneError", status: 409, code: "NO_PUBLISHED_VERSION" })
    expect(event(seen, "run_started")).toBeUndefined()
    expect(event(seen, "responder_done")!.fields["runs_started"]).toBe(0)
  })

  test("run tools are denied (never executed) on a propose-only turn", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_run_start", args: { agent_id: "agent-1", idempotency_key: "t1:run" } }]),
        () => modelMessage("I cannot start runs in this session."),
      ],
    })
    await responder.respond(turn(LEGACY_CALLBACK))
    expect(seen.gateway).toEqual([]) // the gateway was never touched
    expect(String(lastToolResult(seen)["error"])).toContain("ToolDeniedError")
    expect(event(seen, "tool_denied")!.fields).toMatchObject({ turn_id: "t1", tool: "workflow_run_start" })
    expect(event(seen, "run_started")).toBeUndefined()
  })

  test("proposal tools are denied on a run-only turn", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_propose", args: { agent_id: "agent-1", base_generation: 1, base_hash: "h", idempotency_key: "t1" } }]),
        () => modelMessage("cannot propose here"),
      ],
    })
    await responder.respond(turn(RUN_CALLBACK, "rename it"))
    expect(seen.gateway).toEqual([])
    expect(event(seen, "tool_denied")!.fields).toMatchObject({ tool: "workflow_propose", error: "ToolDeniedError" })
  })

  test("workflow_run_wait cannot outspend the one-use token budget", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_run_wait", args: { run_id: "run-77", max_polls: 6, interval_ms: 1000 } }]),
        () => modelMessage("still running"),
      ],
      gateway: () => Response.json(resource({ status: "running" })),
    })
    await responder.respond(turn({ ...RUN_CALLBACK, tokens: ["a", "b"] }, "wait for @run run-77"))
    expect(seen.gateway).toHaveLength(2) // exactly the minted budget
    expect(new Set(seen.gateway.map((call) => call.token)).size).toBe(2)
    expect(String(lastToolResult(seen)["error"])).toContain("token budget exhausted")
    expect(event(seen, "run_wait")).toBeUndefined() // the wait did not complete, so nothing claims it did
  })
})

describe("serve.ts parses callback.features", () => {
  function capturingServe() {
    const captured: TurnRequest[] = []
    const events: { event: string; fields: Record<string, unknown> }[] = []
    const serve = new WorkflowServe({
      workspaceRoot: mkdtempSync(join(tmpdir(), "kcw-run-")),
      trace: (event, fields) => void events.push({ event, fields }),
      responder: {
        name: "capture",
        async respond(request) {
          captured.push(request)
          return { reply: "ok", totalTokens: 1 }
        },
      },
    })
    return { serve, captured, events }
  }

  const AUTH = { authorization: `Bearer ${"t".repeat(32)}` }
  function req(method: string, path: string, body?: unknown): Request {
    return new Request(`http://engine.test${path}`, {
      method,
      headers: { "content-type": "application/json", ...AUTH },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  }

  async function session(serve: WorkflowServe): Promise<string> {
    const response = await serve.fetch(
      req("POST", "/sessions", { product_session_id: "ps-1", agent_id: "agent-1", protocol_version: "v1", profile: "managed-workflow" }),
    )
    return ((await response.json()) as { session_id: string }).session_id
  }

  async function settled(captured: TurnRequest[], count: number): Promise<void> {
    for (let attempt = 0; attempt < 100 && captured.length < count; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
  }

  const callbackBody = (extra: Record<string, unknown>) => ({
    gateway_url: "https://kora.internal:8000",
    agent_id: "agent-1",
    tokens: ["tok-1"],
    ...extra,
  })

  test("an array of strings is kept (non-strings dropped); absent stays absent; empty means reads only", async () => {
    const { serve, captured, events } = capturingServe()
    const sid = await session(serve)
    await serve.fetch(req("POST", `/sessions/${sid}/turns`, { turn_id: "turn-1", epoch: 1, content: "x", history: [], callback: callbackBody({ features: ["run", 42, "propose", null] }) }))
    await serve.fetch(req("POST", `/sessions/${sid}/turns`, { turn_id: "turn-2", epoch: 1, content: "x", history: [], callback: callbackBody({}) }))
    await serve.fetch(req("POST", `/sessions/${sid}/turns`, { turn_id: "turn-3", epoch: 1, content: "x", history: [], callback: callbackBody({ features: [] }) }))
    await serve.fetch(req("POST", `/sessions/${sid}/turns`, { turn_id: "turn-4", epoch: 1, content: "x", history: [], callback: callbackBody({ features: "run" }) }))
    await settled(captured, 4)

    const byTurn = Object.fromEntries(captured.map((request) => [request.turnId, request.callback]))
    expect(byTurn["turn-1"]?.features).toEqual(["run", "propose"])
    expect(byTurn["turn-2"]?.features).toBeUndefined()
    expect(callbackFeatures(byTurn["turn-2"])).toEqual(["propose"]) // legacy default applied in one place
    expect(byTurn["turn-3"]?.features).toEqual([])
    expect(callbackFeatures(byTurn["turn-3"])).toEqual([])
    expect(byTurn["turn-4"]?.features).toBeUndefined() // a bare string is not a grant list
    expect(DEFAULT_CALLBACK_FEATURES).toEqual(["propose"])

    // The trace names the effective grants; the wire events are unchanged.
    const accepted = events.filter((entry) => entry.event === "turn_accepted")
    expect(accepted.map((entry) => entry.fields["callback_features"])).toEqual([["run", "propose"], ["propose"], [], ["propose"]])
    const wire = await serve.fetch(req("GET", `/sessions/${sid}/events?turn_id=turn-1&cursor=0`))
    const { events: wireEvents } = (await wire.json()) as { events: { kind: string; payload: Record<string, unknown> }[] }
    expect(wireEvents[0]!.kind).toBe("turn_accepted")
    expect(Object.keys(wireEvents[0]!.payload).sort()).toEqual(["epoch", "remote_turn_id"])
  })
})
