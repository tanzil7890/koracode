// Phase 12.8 step 7 responder tests: authorization tools are registered ONLY
// when the callback grants 'authorize'; workflow.* subject refs are pinned to
// the turn's agent; the request is linked to the turn and traced; a 409
// NOOP/CONFLICT is surfaced to the model as data and never retried by the
// engine; and reaching for the tools without the grant is traced.

import { describe, expect, test } from "bun:test"

import { LLMResponder, authorizationProcedure } from "../src/llm-responder"
import type { TurnRequest } from "../src/serve"
import { WORKFLOW_AUTHORIZATION_TOOLS, WORKFLOW_PROPOSAL_TOOLS, WORKFLOW_READ_TOOLS, WORKFLOW_RUN_TOOLS } from "../src/tools"

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
}

function responderWith(handlers: {
  model: (() => Response)[]
  gateway?: (url: string, call: number, body: unknown) => Response
}) {
  const seen: Seen = { gateway: [], model: [], events: [] }
  let round = 0
  const responder = new LLMResponder({
    apiKey: "sk-test",
    model: "gpt-test",
    modelOrigin: "https://api.openai.test",
    policy: POLICY,
    trace: (event, fields) => void seen.events.push({ event, fields }),
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

const TOKENS = ["tok-1", "tok-2", "tok-3", "tok-4", "tok-5", "tok-6"]
const LEGACY_CALLBACK = { gatewayUrl: "https://kora.internal:8000", agentId: "agent-1", tokens: TOKENS }
const AUTHORIZE_CALLBACK = { ...LEGACY_CALLBACK, features: ["authorize"] }

const ids = (tools: readonly { id: string }[]) => tools.map((tool) => tool.id)
const registeredTools = (seen: Seen) => (seen.model[0]?.tools ?? []).map((tool) => tool.function.name)
const systemPrompt = (seen: Seen) => seen.model[0]!.messages[0]!.content ?? ""
const event = (seen: Seen, name: string) => seen.events.find((entry) => entry.event === name)
const eventsNamed = (seen: Seen, name: string) => seen.events.filter((entry) => entry.event === name)

function lastToolResult(seen: Seen): Record<string, unknown> {
  const request = seen.model[seen.model.length - 1]!
  const tool = [...request.messages].reverse().find((message) => message.role === "tool")!
  return JSON.parse(tool.content ?? "{}") as Record<string, unknown>
}

function view(overrides: Record<string, unknown> = {}) {
  return {
    authorization_id: "auth-9",
    subject_kind: "workflow.publish",
    subject_ref: { agent_id: "agent-1", label: "v4" },
    binding: { agent_id: "agent-1", head_generation: 7, head_hash: "sha256:h" },
    binding_digest: "sha256:b",
    policy: { risk: "high", decision: "requires_human", reasons: ["publish changes the live definition"] },
    policy_revision: 3,
    rationale: "user asked to publish",
    status: "requested",
    decision_reason: null,
    requested_by: { kind: "engine", id: "kcode" },
    expires_at: "2026-09-02T00:00:00Z",
    granted_by: null,
    granted_at: null,
    grant_id: null,
    consumed_at: null,
    result: null,
    created_at: "2026-09-01T00:00:00Z",
    replayed: false,
    ...overrides,
  }
}

function turn(callback: TurnRequest["callback"], content = "publish this workflow please"): TurnRequest {
  return { turnId: "t1", epoch: 1, content, history: [], callback }
}

const REQUEST_ARGS = {
  subject_kind: "workflow.publish",
  subject_ref: { agent_id: "someone-elses-agent", label: "v4" },
  idempotency_key: "t1:auth",
  rationale: "user asked to publish",
}

describe("feature-gated authorization tool registration", () => {
  test("features ['authorize'] registers read + authorization tools only and adds the AUTHORIZATION PROCEDURE", async () => {
    const { responder, seen } = responderWith({ model: [() => modelMessage("ok")] })
    await responder.respond(turn(AUTHORIZE_CALLBACK))
    expect(registeredTools(seen)).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_AUTHORIZATION_TOOLS]))
    const prompt = systemPrompt(seen)
    expect(prompt).toContain("AUTHORIZATION PROCEDURE")
    expect(prompt).toContain("Authorizations panel")
    expect(prompt).toContain("idempotency_key 't1:auth'")
    expect(prompt).toContain("AUTHORIZATION_SUBJECT_NOOP")
    expect(prompt).toContain("AUTHORIZATION_IDEMPOTENCY_CONFLICT")
    expect(prompt).toContain("AT MOST ONCE with workflow_authorization_get")
    expect(prompt).toContain("cannot grant, deny, revoke, or perform")
    expect(prompt).not.toContain("RUN PROCEDURE")
    expect(prompt).not.toContain("WORKFLOW-CHANGE PROCEDURE")
    expect(event(seen, "responder_done")!.fields).toMatchObject({ features: ["authorize"], authorizations_requested: 0 })
  })

  test("propose-only (legacy) and run-only turns never see the authorization tools or the procedure", async () => {
    for (const callback of [LEGACY_CALLBACK, { ...LEGACY_CALLBACK, features: ["run"] }, { ...LEGACY_CALLBACK, features: ["propose", "run"] }]) {
      const { responder, seen } = responderWith({ model: [() => modelMessage("ok")] })
      await responder.respond(turn(callback))
      for (const tool of WORKFLOW_AUTHORIZATION_TOOLS) expect(registeredTools(seen)).not.toContain(tool.id)
      expect(systemPrompt(seen)).not.toContain("AUTHORIZATION PROCEDURE")
    }
  })

  test("all three grants register everything with all three procedures", async () => {
    const { responder, seen } = responderWith({ model: [() => modelMessage("ok")] })
    await responder.respond(turn({ ...LEGACY_CALLBACK, features: ["propose", "run", "authorize"] }))
    expect(registeredTools(seen)).toEqual(
      ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS, ...WORKFLOW_RUN_TOOLS, ...WORKFLOW_AUTHORIZATION_TOOLS]),
    )
    const prompt = systemPrompt(seen)
    expect(prompt).toContain("WORKFLOW-CHANGE PROCEDURE")
    expect(prompt).toContain("RUN PROCEDURE")
    expect(prompt).toContain("AUTHORIZATION PROCEDURE")
    expect(prompt.indexOf("RUN PROCEDURE")).toBeLessThan(prompt.indexOf("AUTHORIZATION PROCEDURE"))
  })

  test("authorizationProcedure derives the key from the turn id and forbids re-requesting after NOOP/CONFLICT", () => {
    const text = authorizationProcedure("turn-9")
    expect(text).toContain("'turn-9:auth'")
    expect(text).toContain("ONCE per operation")
    expect(text).toContain("do NOT re-request")
    expect(text).toContain("never say the workflow was published")
    expect(text).toContain("details.supported")
    expect(text).toContain("PERMISSION_DENIED")
  })
})

describe("authorization tool dispatch", () => {
  test("request: workflow.* subject pinned to the turn's agent, turn linked, view + reminder returned, traced", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_request_authorization", args: REQUEST_ARGS }]),
        () => modelMessage("Requested authorization auth-9 (status 'requested'); a human must approve it in the Authorizations panel."),
      ],
      gateway: () => Response.json(view(), { status: 202 }),
    })
    const result = await responder.respond(turn(AUTHORIZE_CALLBACK))
    expect(result.reply).toContain("auth-9")

    expect(seen.gateway).toHaveLength(1)
    expect(seen.gateway[0]).toMatchObject({ url: `${BASE}/authorizations`, method: "POST", token: "tok-1" })
    expect(seen.gateway[0]!.body).toEqual({
      subject_kind: "workflow.publish",
      subject_ref: { agent_id: "agent-1", label: "v4" }, // pinned: the model's agent id was replaced
      idempotency_key: "t1:auth",
      rationale: "user asked to publish",
      turn_id: "t1", // engine-set
    })
    const payload = lastToolResult(seen)
    expect(payload).toMatchObject({ authorization_id: "auth-9", status: "requested", replayed: false })
    expect(String(payload["reminder"])).toContain("a human must grant this in the product's Authorizations panel")
    expect(String(payload["reminder"])).toContain("has NOT happened")
    expect(event(seen, "authorization_requested")!.fields).toEqual({
      turn_id: "t1",
      authorization_id: "auth-9",
      subject_kind: "workflow.publish",
      status: "requested",
      replayed: false,
    })
    expect(event(seen, "responder_done")!.fields).toMatchObject({ authorizations_requested: 1, tool_calls: 1, tokens_left: 5 })
    expect(JSON.stringify(seen.events)).not.toContain("publish this workflow please") // traces never carry turn content
  })

  test("a workflow.* request with no subject_ref still gets the pinned agent; non-workflow subjects are not touched", async () => {
    const { responder, seen } = responderWith({
      model: [
        () =>
          modelMessage(null, [
            { name: "workflow_request_authorization", args: { subject_kind: "workflow.restore", subject_ref: { version_number: 3 }, idempotency_key: "t1:auth" } },
            {
              name: "workflow_request_authorization",
              args: { subject_kind: "schedule.update", subject_ref: { schedule_id: "s-1", changes: { enabled: false } }, idempotency_key: "t1:auth2" },
            },
            { name: "workflow_request_authorization", args: { subject_kind: "batch.cancel", subject_ref: { batch_id: "b-1" }, idempotency_key: "t1:auth3" } },
          ]),
        () => modelMessage("done"),
      ],
      gateway: (_url, call, body) =>
        Response.json(
          view({ authorization_id: `auth-${call}`, subject_kind: (body as Record<string, unknown>)["subject_kind"], subject_ref: (body as Record<string, unknown>)["subject_ref"] }),
          { status: 202 },
        ),
    })
    await responder.respond(turn(AUTHORIZE_CALLBACK, "restore v3, disable the schedule, cancel the batch"))
    expect(seen.gateway.map((call) => (call.body as Record<string, unknown>)["subject_ref"])).toEqual([
      { version_number: 3, agent_id: "agent-1" },
      { schedule_id: "s-1", changes: { enabled: false } },
      { batch_id: "b-1" },
    ])
    expect(seen.gateway.every((call) => (call.body as Record<string, unknown>)["turn_id"] === "t1")).toBe(true)
    expect(eventsNamed(seen, "authorization_requested").map((entry) => entry.fields["subject_kind"])).toEqual([
      "workflow.restore",
      "schedule.update",
      "batch.cancel",
    ])
    expect(event(seen, "responder_done")!.fields["authorizations_requested"]).toBe(3)
  })

  test("readback hits GET /authorizations/{id} with the id untouched and attaches the status reminder", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_authorization_get", args: { authorization_id: "auth-9" } }]),
        () => modelMessage("It was granted but has not run yet."),
      ],
      gateway: () => Response.json(view({ status: "granted", granted_by: "u-1", granted_at: "now", grant_id: "g-1" })),
    })
    await responder.respond(turn(AUTHORIZE_CALLBACK, "was auth-9 approved?"))
    expect(seen.gateway[0]).toMatchObject({ url: `${BASE}/authorizations/auth-9`, method: "GET" })
    const payload = lastToolResult(seen)
    expect(payload["status"]).toBe("granted")
    expect(String(payload["reminder"])).toContain("has NOT run yet")
    expect(event(seen, "authorization_requested")).toBeUndefined() // a readback is not a request
  })

  test("a replayed request (same idempotency_key) is traced as replayed", async () => {
    const { responder, seen } = responderWith({
      model: [() => modelMessage(null, [{ name: "workflow_request_authorization", args: REQUEST_ARGS }]), () => modelMessage("already requested")],
      gateway: () => Response.json(view({ replayed: true }), { status: 202 }),
    })
    await responder.respond(turn(AUTHORIZE_CALLBACK))
    expect(event(seen, "authorization_requested")!.fields["replayed"]).toBe(true)
    expect(lastToolResult(seen)["replayed"]).toBe(true)
  })

  test.each([
    ["AUTHORIZATION_SUBJECT_NOOP", 409, "head is identical to the live version"],
    ["AUTHORIZATION_IDEMPOTENCY_CONFLICT", 409, "an equivalent request already exists"],
  ])("a 409 %s is surfaced to the model as data and the engine never re-requests", async (code, status, message) => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_request_authorization", args: REQUEST_ARGS }]),
        () => modelMessage(`Nothing to request: ${code} — ${message}.`),
      ],
      gateway: () => Response.json({ detail: { code, message } }, { status }),
    })
    const result = await responder.respond(turn(AUTHORIZE_CALLBACK))
    expect(result.reply).toContain(code)
    expect(seen.gateway).toHaveLength(1) // exactly one request; no engine-side retry
    const payload = lastToolResult(seen)
    expect(payload).toMatchObject({ status, code, message })
    expect(String(payload["error"])).toContain("ControlPlaneError")
    expect(payload["reminder"]).toBeUndefined() // an error is not a view
    expect(event(seen, "tool_failed")!.fields).toMatchObject({ turn_id: "t1", tool: "workflow_request_authorization", error: "ControlPlaneError", status, code })
    expect(event(seen, "authorization_requested")).toBeUndefined()
    expect(event(seen, "responder_done")!.fields["authorizations_requested"]).toBe(0)
  })

  test("a 422 AUTHORIZATION_SUBJECT_UNSUPPORTED hands the model the supported kinds under details", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_request_authorization", args: { ...REQUEST_ARGS, subject_kind: "workflow.delete" } }]),
        () => modelMessage("That operation cannot be authorized here."),
      ],
      gateway: () =>
        Response.json(
          { detail: { code: "AUTHORIZATION_SUBJECT_UNSUPPORTED", message: "unsupported subject", supported: ["workflow.publish", "workflow.restore"] } },
          { status: 422 },
        ),
    })
    await responder.respond(turn(AUTHORIZE_CALLBACK, "delete the workflow"))
    const payload = lastToolResult(seen)
    expect(payload["code"]).toBe("AUTHORIZATION_SUBJECT_UNSUPPORTED")
    expect(payload["details"]).toEqual({ supported: ["workflow.publish", "workflow.restore"] })
    // Even an unsupported workflow.* kind gets the pinned agent — the gateway decides, not the model.
    expect((seen.gateway[0]!.body as Record<string, unknown>)["subject_ref"]).toEqual({ agent_id: "agent-1", label: "v4" })
  })

  const UNGRANTED: [string, { gatewayUrl: string; agentId: string; tokens: string[]; features?: string[] }][] = [
    ["propose-only (legacy)", LEGACY_CALLBACK],
    ["run-only", { ...LEGACY_CALLBACK, features: ["run"] }],
    ["propose+run", { ...LEGACY_CALLBACK, features: ["propose", "run"] }],
  ]

  test.each(UNGRANTED)("on a %s turn the authorization tools are denied without a gateway call, and the denial is traced", async (_label, callback) => {
    const { responder, seen } = responderWith({
      model: [
        () =>
          modelMessage(null, [
            { name: "workflow_request_authorization", args: REQUEST_ARGS },
            { name: "workflow_authorization_get", args: { authorization_id: "auth-9" } },
          ]),
        () => modelMessage("I cannot request authorizations in this session."),
      ],
    })
    await responder.respond(turn(callback))
    expect(seen.gateway).toEqual([]) // the gateway was never touched
    expect(String(lastToolResult(seen)["error"])).toContain("ToolDeniedError")
    expect(eventsNamed(seen, "tool_denied").map((entry) => entry.fields["tool"])).toEqual([
      "workflow_request_authorization",
      "workflow_authorization_get",
    ])
    const specific = eventsNamed(seen, "authorization_denied_tool")
    expect(specific.map((entry) => entry.fields["tool"])).toEqual(["workflow_request_authorization", "workflow_authorization_get"])
    expect(specific[0]!.fields).toEqual({ turn_id: "t1", tool: "workflow_request_authorization", features: callback.features ?? ["propose"] })
    expect(event(seen, "authorization_requested")).toBeUndefined()
  })

  test("a denied non-authorization tool does not produce the authorization-specific trace", async () => {
    const { responder, seen } = responderWith({
      model: [
        () => modelMessage(null, [{ name: "workflow_grant_authorization", args: { authorization_id: "auth-9" } }]),
        () => modelMessage("no such tool"),
      ],
    })
    await responder.respond(turn(AUTHORIZE_CALLBACK, "grant auth-9"))
    expect(seen.gateway).toEqual([])
    expect(event(seen, "tool_denied")!.fields["tool"]).toBe("workflow_grant_authorization")
    expect(event(seen, "authorization_denied_tool")).toBeUndefined() // grant never existed; it is not a feature-gated tool
  })
})
