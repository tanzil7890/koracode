// Phase 12.7 model-responder tests: the OpenAI tool-calling loop over the
// proposal surface — pinned egress, one-use token consumption, denied tools
// surfacing as data, hard tool budgets, and (v7) the propose interception:
// normalize → local lint → gateway validate → propose only when valid.
// All fetches are injected.

import { describe, expect, test } from "bun:test"

import { LLMResponder } from "../src/llm-responder"
import { EgressDeniedError } from "../src/egress"

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

interface Seen {
  urls: string[]
  tokens: string[]
  gatewayBodies: { url: string; body: unknown }[]
  modelRequests: { messages: { role: string; content: string | null }[] }[]
}

function responderWith(handlers: {
  model: ((round: number) => Response)[]
  gateway?: (url: string, call: number, body: unknown) => Response
}) {
  const seen: Seen = { urls: [], tokens: [], gatewayBodies: [], modelRequests: [] }
  let modelRound = 0
  let gatewayCall = 0
  const responder = new LLMResponder({
    apiKey: "sk-test",
    model: "gpt-test",
    modelOrigin: "https://api.openai.test",
    policy: POLICY,
    fetchImpl: (async (url: any, init?: RequestInit) => {
      const target = String(url)
      seen.urls.push(target)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (target.startsWith("https://kora.internal")) {
        const auth = new Headers(init?.headers).get("authorization") ?? ""
        seen.tokens.push(auth.replace("Bearer ", ""))
        seen.gatewayBodies.push({ url: target, body })
        return handlers.gateway ? handlers.gateway(target, gatewayCall++, body) : Response.json({})
      }
      seen.modelRequests.push(body)
      const handler = handlers.model[Math.min(modelRound, handlers.model.length - 1)]!
      modelRound += 1
      return handler(modelRound)
    }) as typeof fetch,
  })
  return { responder, seen }
}

const CALLBACK = {
  gatewayUrl: "https://kora.internal:8000",
  agentId: "agent-1",
  tokens: ["tok-1", "tok-2", "tok-3", "tok-4", "tok-5", "tok-6"],
}

/** A gateway that answers head, validate (ok unless told otherwise), and propose. */
function gatewayOk(validate: (body: any) => { ok: boolean; issues?: unknown[] } = () => ({ ok: true })) {
  return (url: string, _call: number, body: unknown) => {
    if (url.endsWith("/proposals/validate")) {
      const verdict = validate(body)
      return Response.json({ validation: verdict, risk_level: "low", diff: {} })
    }
    if (url.endsWith("/proposals")) return Response.json({ change_set_id: "cs-1", status: "proposed", risk_level: "low" })
    return Response.json({ generation: 3, content_hash: "sha256:h", graph: HEAD_GRAPH })
  }
}

function lastToolResult(seen: Seen): any {
  const request = seen.modelRequests[seen.modelRequests.length - 1]!
  const tool = [...request.messages].reverse().find((m) => m.role === "tool")!
  return JSON.parse(tool.content ?? "{}")
}

describe("LLMResponder", () => {
  test("refuses construction when the model origin is off-policy", () => {
    expect(
      () =>
        new LLMResponder({
          apiKey: "k",
          model: "m",
          modelOrigin: "https://evil.example",
          policy: POLICY,
        }),
    ).toThrow(EgressDeniedError)
  })

  test("plain answer without callback uses no tools and no gateway", async () => {
    const { responder, seen } = responderWith({ model: [() => modelMessage("just an answer")] })
    const result = await responder.respond({ turnId: "t1", epoch: 1, content: "hi", history: [] })
    expect(result.reply).toBe("just an answer")
    expect(result.totalTokens).toBe(50)
    expect(seen.urls.every((url) => url.startsWith("https://api.openai.test"))).toBe(true)
  })

  test("tool loop: head → (engine validate) → propose → final reply, one one-use token per gateway call", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "agent-1" } }]),
        () =>
          modelMessage(null, [
            {
              name: "workflow_propose",
              args: {
                agent_id: "agent-1",
                base_generation: 3,
                base_hash: "sha256:h",
                candidate_graph: { ...HEAD_GRAPH, name: "Renamed" },
                idempotency_key: "t1",
              },
            },
          ]),
        () => modelMessage("Proposed the rename as change set cs-1."),
      ],
      gateway: gatewayOk(),
    })
    const result = await responder.respond({ turnId: "t1", epoch: 1, content: "rename it", history: [], callback: CALLBACK })
    expect(result.reply).toContain("cs-1")
    expect(result.totalTokens).toBe(150) // three model rounds
    expect(seen.tokens).toEqual(["tok-1", "tok-2", "tok-3"]) // head, validate, propose — one distinct token each
    expect(seen.gatewayBodies.map((g) => g.url.split("/").slice(-1)[0])).toEqual(["head", "validate", "proposals"])
  })

  test("a denied tool name surfaces as data and never executes", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "bash", args: { command: "rm -rf /" } }]),
        () => modelMessage("understood, cannot do that"),
      ],
    })
    const result = await responder.respond({ turnId: "t1", epoch: 1, content: "run bash", history: [], callback: CALLBACK })
    expect(result.reply).toContain("cannot")
    expect(seen.tokens).toEqual([]) // the gateway was never touched
    expect(seen.urls.filter((url) => url.includes("kora.internal"))).toEqual([])
  })

  test("running out of one-use tokens stops gateway calls as a hard budget", async () => {
    // The model asks for the head on every round; only 3 tokens exist.
    const { responder, seen } = responderWith({
      model: [() => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "agent-1" } }])],
      gateway: () => Response.json({ generation: 1, content_hash: "h", graph: {} }),
    })
    await responder.respond({ turnId: "t1", epoch: 1, content: "loop", history: [], callback: { ...CALLBACK, tokens: ["a", "b", "c"] } })
    expect(seen.tokens.length).toBe(3) // exactly the minted budget, never more
    expect(new Set(seen.tokens).size).toBe(3) // all distinct — one-use each
  })

  test("an off-contract candidate is normalized before validate/propose and the repairs are reported", async () => {
    const sloppy = {
      name: "Form",
      entry: "n1",
      variables: ["NAME"],
      nodes: [
        { id: "n1", type: "agent", name: "Open", instruction: "Open the form and fill {{.NAME}} {{.EMAIL}}" },
        { id: "n2", type: "agent", name: "Submit", instruction: "Submit", scripts: [{ filename: "submit.js" }] },
        { id: "ok", type: "success", position: { x: 1, y: 1 } },
        { id: "err", type: "error", position: { x: 1, y: 1 } },
      ],
      edges: [
        { id: "e1", from: "n1", to: "n2", when: "success" },
        { id: "e2", from: "n1", to: "err", when: "failure" },
        { id: "e3", from: "n2", to: "ok", when: "success" },
        { id: "e4", from: "n2", to: "err", when: "error" },
      ],
    }
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "agent-1" } }]),
        () =>
          modelMessage(null, [
            {
              name: "workflow_propose",
              args: { agent_id: "agent-1", base_generation: 3, base_hash: "sha256:h", candidate_graph: sloppy, idempotency_key: "t1" },
            },
          ]),
        () => modelMessage("done"),
      ],
      gateway: gatewayOk(),
    })
    await responder.respond({ turnId: "t1", epoch: 1, content: "build it", history: [], callback: CALLBACK })
    const validateBody = seen.gatewayBodies.find((g) => g.url.endsWith("/validate"))!.body as any
    const proposeBody = seen.gatewayBodies.find((g) => g.url.endsWith("/proposals"))!.body as any
    expect(validateBody.candidate_graph).toEqual(proposeBody.candidate_graph) // exactly what was validated is proposed
    const sent = proposeBody.candidate_graph
    expect(sent.version).toBe(3)
    expect(sent.variables).toEqual([{ name: "NAME" }, { name: "EMAIL" }])
    expect(sent.nodes[0].position).toBeDefined()
    expect(sent.nodes[1].script).toEqual({ filepath: "./scripts/submit.js", failure_action: "fallback_to_ai" })
    expect(sent.nodes[1].scripts).toBeUndefined()
    expect(sent.edges[1].when).toBe("error")
    expect(proposeBody.patch_ops).toBeUndefined()
    const result = lastToolResult(seen)
    expect(result.status).toBe("proposed")
    expect(result.repairs.map((r: any) => r.code)).toContain("VARIABLE_DECLARED")
    expect(result.repairs.map((r: any) => r.code)).toContain("SCRIPTS_ENTRY_TO_SCRIPT")
  })

  test("a locally-invalid candidate costs no gateway token and comes back as guidance; the fixed retry is proposed", async () => {
    const broken = { ...HEAD_GRAPH, edges: [{ id: "e1", from: "n1", to: "ghost", when: "success" }, HEAD_GRAPH.edges[1]] }
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "agent-1" } }]),
        () =>
          modelMessage(null, [
            { name: "workflow_propose", args: { agent_id: "agent-1", base_generation: 3, base_hash: "sha256:h", candidate_graph: broken, idempotency_key: "t1" } },
          ]),
        () =>
          modelMessage(null, [
            {
              name: "workflow_propose",
              args: { agent_id: "agent-1", base_generation: 3, base_hash: "sha256:h", candidate_graph: HEAD_GRAPH, idempotency_key: "t1:retry1" },
            },
          ]),
        () => modelMessage("proposed after fixing the edge"),
      ],
      gateway: gatewayOk(),
    })
    const result = await responder.respond({ turnId: "t1", epoch: 1, content: "x", history: [], callback: CALLBACK })
    expect(result.reply).toContain("proposed")
    // head, then (retry) validate + propose — the broken attempt never reached the gateway.
    expect(seen.tokens).toEqual(["tok-1", "tok-2", "tok-3"])
    const guidanceRound = seen.modelRequests[2]!
    const toolMessage = [...guidanceRound.messages].reverse().find((m) => m.role === "tool")!
    const payload = JSON.parse(toolMessage.content!)
    expect(payload.status).toBe("not_proposed")
    expect(payload.reason).toBe("engine_precheck_failed")
    expect(payload.guidance.join(" ")).toContain("EDGE_ENDPOINT_MISSING")
  })

  test("a gateway-rejected candidate is never proposed; issues become guidance", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "agent-1" } }]),
        () =>
          modelMessage(null, [
            { name: "workflow_propose", args: { agent_id: "agent-1", base_generation: 3, base_hash: "sha256:h", candidate_graph: HEAD_GRAPH, idempotency_key: "t1" } },
          ]),
        () => modelMessage("I could not complete the change."),
        () => modelMessage("No change is needed after all."),
      ],
      gateway: gatewayOk(() => ({
        ok: false,
        issues: [{ code: "SCHEMA_SOURCE_REQUIRED", message: "nodes/n1/input_schema/properties/a", node_id: "n1" }],
      })),
    })
    const result = await responder.respond({ turnId: "t1", epoch: 1, content: "x", history: [], callback: CALLBACK })
    expect(seen.gatewayBodies.some((g) => g.url.endsWith("/proposals"))).toBe(false) // no change set row was ever requested
    const guidanceRound = seen.modelRequests[2]!
    const payload = JSON.parse([...guidanceRound.messages].reverse().find((m) => m.role === "tool")!.content!)
    expect(payload.status).toBe("not_proposed")
    expect(payload.reason).toBe("validation_failed")
    expect(payload.guidance.join(" ")).toContain("x-source")
    // The one-shot nudge fired: a user message asking to finish or justify, then the model answered.
    const nudgeRound = seen.modelRequests[3]!
    expect(nudgeRound.messages[nudgeRound.messages.length - 1]!.role).toBe("user")
    expect(nudgeRound.messages[nudgeRound.messages.length - 1]!.content).toContain("No change set was created")
    expect(result.reply).toBe("No change is needed after all.")
    expect(result.totalTokens).toBe(200) // exactly one extra round for the nudge
  })

  test("patch_ops are applied to the snapshotted head, normalized, validated, and proposed as a candidate", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "agent-1" } }]),
        () =>
          modelMessage(null, [
            {
              name: "workflow_propose",
              args: {
                agent_id: "agent-1",
                base_generation: 3,
                base_hash: "sha256:h",
                idempotency_key: "t1",
                patch_ops: [
                  { op: "remove_edge", id: "e1" },
                  { op: "add_node", node: { id: "c1", type: "condition", name: "MFA?", check: { kind: "text_present", value: "MFA required" } } },
                  { op: "add_edge", edge: { id: "e1", from: "n1", to: "c1", when: "success" } },
                  { op: "add_edge", edge: { id: "t1", from: "c1", to: "err", when: "true" } },
                  { op: "add_edge", edge: { id: "f1", from: "c1", to: "ok", when: "false" } },
                ],
              },
            },
          ]),
        () => modelMessage("inserted the condition"),
      ],
      gateway: gatewayOk(),
    })
    await responder.respond({ turnId: "t1", epoch: 1, content: "add a condition", history: [], callback: CALLBACK })
    const proposeBody = seen.gatewayBodies.find((g) => g.url.endsWith("/proposals"))!.body as any
    expect(proposeBody.patch_ops).toBeUndefined()
    const sent = proposeBody.candidate_graph
    expect(sent.nodes.map((n: any) => n.id)).toEqual(["n1", "ok", "err", "c1"])
    expect(sent.nodes[3].position).toBeDefined() // normalized after the patch
    expect(sent.edges.map((e: any) => e.id)).toEqual(["e2", "e1", "t1", "f1"])
    expect(seen.tokens).toEqual(["tok-1", "tok-2", "tok-3"]) // head (snapshotted), validate, propose
  })

  test("the model cannot pick the agent: a mistyped agent_id is pinned to the turn's callback agent", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "06a97644-36e1-8000-fa09f3b3200a" } }]),
        () =>
          modelMessage(null, [
            {
              name: "workflow_propose",
              args: { agent_id: "someone-elses-agent", base_generation: 3, base_hash: "sha256:h", candidate_graph: HEAD_GRAPH, idempotency_key: "t1" },
            },
          ]),
        () => modelMessage("done"),
      ],
      gateway: gatewayOk(),
    })
    await responder.respond({ turnId: "t1", epoch: 1, content: "x", history: [], callback: CALLBACK })
    const gatewayUrls = seen.urls.filter((url) => url.includes("kora.internal"))
    expect(gatewayUrls.length).toBe(3)
    expect(gatewayUrls.every((url) => url.includes("/workflows/agent-1/"))).toBe(true)
  })

  test("a patch that cannot apply is refused with guidance and no gateway spend", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_head", args: { agent_id: "agent-1" } }]),
        () =>
          modelMessage(null, [
            {
              name: "workflow_propose",
              args: { agent_id: "agent-1", base_generation: 3, base_hash: "sha256:h", idempotency_key: "t1", patch_ops: [{ op: "remove_edge", id: "nope" }] },
            },
          ]),
        () => modelMessage("giving up"),
        () => modelMessage("no change"),
      ],
      gateway: gatewayOk(),
    })
    await responder.respond({ turnId: "t1", epoch: 1, content: "x", history: [], callback: CALLBACK })
    expect(seen.tokens).toEqual(["tok-1"])
    const payload = JSON.parse([...seen.modelRequests[2]!.messages].reverse().find((m) => m.role === "tool")!.content!)
    expect(payload.status).toBe("not_proposed")
    expect(payload.reason).toBe("patch_rejected")
    expect(payload.guidance[0]).toContain("edge nope does not exist")
  })
})
