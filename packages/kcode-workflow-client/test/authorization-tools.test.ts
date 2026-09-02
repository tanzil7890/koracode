// Phase 12.8 step 7 tests: the request-only authorization tool surface —
// exact gateway paths/bodies for request and readback, feature-gated
// resolution (only 'authorize' unlocks them), the status reminder, the typed
// error details, and the profile posture (deny-by-default; grant/approve/
// revoke exist nowhere).

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { ControlPlaneError, WorkflowControlPlaneClient } from "../src/client"
import {
  AUTHORIZE_WORKFLOW_PROFILE,
  FORBIDDEN_TOOL_IDS,
  MANAGED_WORKFLOW_PROFILE,
  PROPOSAL_WORKFLOW_PROFILE,
  RUN_WORKFLOW_PROFILE,
  UNTRUSTED_CONTENT_POLICY,
  profileAllows,
} from "../src/profile"
import {
  AUTHORIZATION_STATUSES,
  AUTHORIZATION_SUBJECT_KINDS,
  ToolDeniedError,
  WORKFLOW_AUTHORIZATION_TOOLS,
  WORKFLOW_PROPOSAL_TOOLS,
  WORKFLOW_READ_TOOLS,
  WORKFLOW_RUN_TOOLS,
  assertReadOnlySurface,
  authorizationReminder,
  isAuthorizationToolId,
  resolveAuthorizationTool,
  resolveFeatureTool,
  resolveProposalTool,
  resolveRunTool,
  resolveTool,
  toolsForFeatures,
} from "../src/tools"

const POLICY = { allowedOrigins: ["https://kora.internal:8000"] }
const BASE = "https://kora.internal:8000/internal/kora/v1"

interface Call {
  url: string
  method: string
  body?: unknown
  token: string
}

function clientWith(handler: (url: string, call: number, body: unknown) => Response) {
  const calls: Call[] = []
  let minted = 0
  const client = new WorkflowControlPlaneClient({
    baseUrl: "https://kora.internal:8000",
    tokenProvider: () => `tok-${++minted}`,
    policy: POLICY,
    fetchImpl: (async (url: any, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const token = (new Headers(init?.headers).get("authorization") ?? "").replace("Bearer ", "")
      calls.push({ url: String(url), method: init?.method ?? "GET", body, token })
      return handler(String(url), calls.length, body)
    }) as typeof fetch,
  })
  return { client, calls }
}

/** A gateway authorization view with the contract's fields. */
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

const ids = (tools: readonly { id: string }[]) => tools.map((tool) => tool.id)
const authTool = (id: string) => WORKFLOW_AUTHORIZATION_TOOLS.find((tool) => tool.id === id)!
const AUTHORIZATION_TOOL_IDS = ["workflow_request_authorization", "workflow_authorization_get"]
const DECISION_TOOL_IDS = [
  "workflow_grant_authorization",
  "workflow_approve_authorization",
  "workflow_authorization_grant",
  "workflow_deny_authorization",
  "workflow_revoke_authorization",
  "grant",
]

describe("authorization client operations (wire contract)", () => {
  test("requestAuthorization POSTs /authorizations with the exact body and returns the 202 view", async () => {
    const { client, calls } = clientWith(() => Response.json(view(), { status: 202 }))
    const out = (await client.requestAuthorization({
      subject_kind: "workflow.publish",
      subject_ref: { agent_id: "agent-1", label: "v4" },
      idempotency_key: "t1:auth",
      rationale: "user asked to publish",
      turn_id: "t1",
    })) as Record<string, unknown>
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: `${BASE}/authorizations`, method: "POST" })
    expect(calls[0]!.body).toEqual({
      subject_kind: "workflow.publish",
      subject_ref: { agent_id: "agent-1", label: "v4" },
      idempotency_key: "t1:auth",
      rationale: "user asked to publish",
      turn_id: "t1",
    })
    expect(out["authorization_id"]).toBe("auth-9")
    expect(out["status"]).toBe("requested")
    expect((out["policy"] as Record<string, unknown>)["decision"]).toBe("requires_human")
  })

  test("getAuthorization GETs /authorizations/{authorization_id}, URL-encoded, one fresh token per call", async () => {
    const { client, calls } = clientWith(() => Response.json(view({ status: "granted", granted_by: "u-1" })))
    await client.getAuthorization("auth-9")
    expect(calls[0]).toMatchObject({ url: `${BASE}/authorizations/auth-9`, method: "GET" })
    expect(calls[0]!.body).toBeUndefined()
    await client.getAuthorization("../grant")
    expect(calls[1]!.url).toBe(`${BASE}/authorizations/..%2Fgrant`)
    expect(calls.map((call) => call.token)).toEqual(["tok-1", "tok-2"])
  })

  test.each([
    ["AUTHORIZATION_SUBJECT_UNSUPPORTED", 422],
    ["AUTHORIZATION_SUBJECT_REF_INVALID", 422],
    ["AUTHORIZATION_SUBJECT_NOT_FOUND", 404],
    ["AUTHORIZATION_SUBJECT_NOOP", 409],
    ["AUTHORIZATION_IDEMPOTENCY_CONFLICT", 409],
    ["PERMISSION_DENIED", 403],
  ])("a typed %s (%i) error surfaces its code with the status prefix intact", async (code, status) => {
    const { client } = clientWith(() => Response.json({ detail: { code, message: `${code} happened` } }, { status }))
    const error = (await client
      .requestAuthorization({ subject_kind: "batch.cancel", subject_ref: { batch_id: "b-1" }, idempotency_key: "k" })
      .catch((e: unknown) => e)) as ControlPlaneError
    expect(error).toBeInstanceOf(ControlPlaneError)
    expect(error.status).toBe(status)
    expect(error.code).toBe(code)
    expect(error.message).toBe(`gateway returned ${status} (${code}: ${code} happened)`)
    expect(error.extra).toBeUndefined()
  })

  test("extra typed-detail keys (e.g. supported) are kept on the error", async () => {
    const { client } = clientWith(() =>
      Response.json(
        { detail: { code: "AUTHORIZATION_SUBJECT_UNSUPPORTED", message: "unsupported subject", supported: [...AUTHORIZATION_SUBJECT_KINDS] } },
        { status: 422 },
      ),
    )
    const error = (await client
      .requestAuthorization({ subject_kind: "workflow.delete" as never, subject_ref: {}, idempotency_key: "k" })
      .catch((e: unknown) => e)) as ControlPlaneError
    expect(error.code).toBe("AUTHORIZATION_SUBJECT_UNSUPPORTED")
    expect(error.extra).toEqual({ supported: [...AUTHORIZATION_SUBJECT_KINDS] })
    expect(error.message).toBe("gateway returned 422 (AUTHORIZATION_SUBJECT_UNSUPPORTED: unsupported subject)")
  })

  test("the client has NO grant, deny, revoke, approve, apply, publish, restore, or schedule method", () => {
    const surface = Object.getOwnPropertyNames(WorkflowControlPlaneClient.prototype)
    expect(surface.some((name) => /grant|deny|revoke|approve|apply|publish|restore|schedule|setLive|set_live/i.test(name))).toBe(false)
    expect(surface).toContain("requestAuthorization")
    expect(surface).toContain("getAuthorization")
  })
})

describe("authorization tool surface", () => {
  test("WORKFLOW_AUTHORIZATION_TOOLS are exactly request + get with closed schemas and the six subject kinds", () => {
    expect(ids(WORKFLOW_AUTHORIZATION_TOOLS)).toEqual(AUTHORIZATION_TOOL_IDS)
    for (const tool of WORKFLOW_AUTHORIZATION_TOOLS) {
      expect((tool.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    }
    const request = authTool("workflow_request_authorization").parameters as {
      properties: Record<string, { enum?: string[] }>
      required: string[]
    }
    expect(request.required).toEqual(["subject_kind", "subject_ref", "idempotency_key"])
    expect(request.properties["subject_kind"]!.enum).toEqual([
      "workflow.publish",
      "workflow.restore",
      "workflow.set_live",
      "schedule.update",
      "schedule.delete",
      "batch.cancel",
    ])
    expect(Object.keys(request.properties)).not.toContain("turn_id") // engine-set, never model-set
    expect(authTool("workflow_request_authorization").description).toContain("nothing is performed by this call")
    expect(authTool("workflow_request_authorization").description).toContain("AUTHORIZATION_SUBJECT_NOOP")
    expect(authTool("workflow_authorization_get").description).toContain("Only 'consumed' means the operation was performed")
    expect(AUTHORIZATION_STATUSES).toEqual(["requested", "granted", "consumed", "denied", "expired", "revoked", "superseded", "failed"])
  })

  test("resolveAuthorizationTool serves read + authorization tools and denies decision, run, proposal, and host tools", () => {
    for (const tool of WORKFLOW_AUTHORIZATION_TOOLS) expect(resolveAuthorizationTool(tool.id).id).toBe(tool.id)
    for (const tool of WORKFLOW_READ_TOOLS) expect(resolveAuthorizationTool(tool.id).id).toBe(tool.id)
    for (const denied of [...DECISION_TOOL_IDS, "workflow_run_start", "workflow_propose", "workflow_publish", "bash", "edit", "browser_execute"]) {
      expect(() => resolveAuthorizationTool(denied)).toThrow(ToolDeniedError)
    }
    expect(isAuthorizationToolId("workflow_request_authorization")).toBe(true)
    expect(isAuthorizationToolId("workflow_grant_authorization")).toBe(false)
    expect(isAuthorizationToolId("workflow_head")).toBe(false)
  })

  test("the read-only, proposal, and run resolvers do NOT gain authorization tools", () => {
    for (const tool of WORKFLOW_AUTHORIZATION_TOOLS) {
      expect(() => resolveTool(tool.id)).toThrow(ToolDeniedError)
      expect(() => resolveProposalTool(tool.id)).toThrow(ToolDeniedError)
      expect(() => resolveRunTool(tool.id)).toThrow(ToolDeniedError)
    }
    expect(() => assertReadOnlySurface([...ids(WORKFLOW_READ_TOOLS), "workflow_request_authorization"])).toThrow(ToolDeniedError)
  })

  test("only the 'authorize' grant unlocks them: propose-only and run-only turns cannot resolve them", () => {
    expect(ids(toolsForFeatures(["authorize"]))).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_AUTHORIZATION_TOOLS]))
    expect(ids(toolsForFeatures(["propose", "run", "authorize"]))).toEqual(
      ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS, ...WORKFLOW_RUN_TOOLS, ...WORKFLOW_AUTHORIZATION_TOOLS]),
    )
    for (const tool of WORKFLOW_AUTHORIZATION_TOOLS) {
      expect(() => resolveFeatureTool(["propose"], tool.id)).toThrow(ToolDeniedError)
      expect(() => resolveFeatureTool(["run"], tool.id)).toThrow(ToolDeniedError)
      expect(() => resolveFeatureTool(["propose", "run"], tool.id)).toThrow(ToolDeniedError)
      expect(() => resolveFeatureTool([], tool.id)).toThrow(ToolDeniedError)
      expect(resolveFeatureTool(["authorize"], tool.id).id).toBe(tool.id)
    }
    for (const denied of DECISION_TOOL_IDS) expect(() => resolveFeatureTool(["authorize"], denied)).toThrow(ToolDeniedError)
    expect(() => resolveFeatureTool(["authorize"], "workflow_run_start")).toThrow(ToolDeniedError)
  })

  test("the request tool maps its args onto the exact body and attaches the status reminder", async () => {
    const { client, calls } = clientWith(() => Response.json(view(), { status: 202 }))
    const result = (await authTool("workflow_request_authorization").execute(client, {
      subject_kind: "workflow.publish",
      subject_ref: { agent_id: "agent-1", label: "v4" },
      idempotency_key: "t1:auth",
      rationale: "user asked to publish",
      turn_id: "t1",
    })) as Record<string, unknown>
    expect(calls[0]).toMatchObject({ url: `${BASE}/authorizations`, method: "POST" })
    expect(calls[0]!.body).toEqual({
      subject_kind: "workflow.publish",
      subject_ref: { agent_id: "agent-1", label: "v4" },
      idempotency_key: "t1:auth",
      rationale: "user asked to publish",
      turn_id: "t1",
    })
    expect(result["authorization_id"]).toBe("auth-9")
    expect(result["status"]).toBe("requested")
    expect(result["reminder"]).toBe(authorizationReminder("requested"))
    expect(String(result["reminder"])).toContain("human must grant this")
    expect(String(result["reminder"])).toContain("has NOT happened")

    // Optional fields are omitted, never sent as empty strings.
    await authTool("workflow_request_authorization").execute(client, {
      subject_kind: "schedule.update",
      subject_ref: { schedule_id: "s-1", changes: { enabled: false } },
      idempotency_key: "t1:auth2",
    })
    expect(calls[1]!.body).toEqual({
      subject_kind: "schedule.update",
      subject_ref: { schedule_id: "s-1", changes: { enabled: false } },
      idempotency_key: "t1:auth2",
    })
  })

  test("the get tool reads back and attaches the reminder for the returned status", async () => {
    const { client, calls } = clientWith(() => Response.json(view({ status: "consumed", consumed_at: "now", result: { version_number: 4 } })))
    const result = (await authTool("workflow_authorization_get").execute(client, { authorization_id: "auth-9" })) as Record<string, unknown>
    expect(calls[0]).toMatchObject({ url: `${BASE}/authorizations/auth-9`, method: "GET" })
    expect(result["status"]).toBe("consumed")
    expect(result["reminder"]).toBe(authorizationReminder("consumed"))
  })

  test("authorizationReminder: only 'consumed' says the operation happened", () => {
    expect(authorizationReminder("requested")).toContain("Authorizations panel")
    expect(authorizationReminder("requested")).toContain("never say it has")
    expect(authorizationReminder("granted")).toContain("has NOT run yet")
    expect(authorizationReminder("consumed")).toContain("was performed")
    for (const status of ["denied", "expired", "revoked", "superseded", "failed"]) {
      expect(authorizationReminder(status)).toContain(`status '${status}' means the operation will not happen`)
      expect(authorizationReminder(status)).toContain("do not re-request")
    }
    expect(authorizationReminder(undefined)).toContain("do not claim the operation happened")
    for (const status of AUTHORIZATION_STATUSES) {
      if (status !== "consumed") expect(authorizationReminder(status)).not.toContain("was performed")
    }
  })
})

describe("authorization profile posture", () => {
  test("AUTHORIZE_WORKFLOW_PROFILE is deny-by-default and allows exactly the read + authorization tools", () => {
    expect(AUTHORIZE_WORKFLOW_PROFILE.tools["*"]).toBe(false)
    const allowed = Object.entries(AUTHORIZE_WORKFLOW_PROFILE.tools)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id)
      .sort()
    expect(allowed).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_AUTHORIZATION_TOOLS]).sort())
    expect(profileAllows(AUTHORIZE_WORKFLOW_PROFILE, "workflow_run_start")).toBe(false)
    expect(profileAllows(AUTHORIZE_WORKFLOW_PROFILE, "workflow_propose")).toBe(false)
    expect(profileAllows(AUTHORIZE_WORKFLOW_PROFILE, "some_new_tool_2027")).toBe(false)
    expect(AUTHORIZE_WORKFLOW_PROFILE.environment).toBe(MANAGED_WORKFLOW_PROFILE.environment)
  })

  test("grant/approve/revoke decision ids are forbidden and denied by every profile", () => {
    for (const id of DECISION_TOOL_IDS) expect(FORBIDDEN_TOOL_IDS).toContain(id)
    for (const id of FORBIDDEN_TOOL_IDS) {
      expect(profileAllows(MANAGED_WORKFLOW_PROFILE, id)).toBe(false)
      expect(profileAllows(PROPOSAL_WORKFLOW_PROFILE, id)).toBe(false)
      expect(profileAllows(RUN_WORKFLOW_PROFILE, id)).toBe(false)
      expect(profileAllows(AUTHORIZE_WORKFLOW_PROFILE, id)).toBe(false)
    }
  })

  test("authorization tools are NOT granted by the read-only, proposal, or run profiles", () => {
    for (const tool of WORKFLOW_AUTHORIZATION_TOOLS) {
      expect(profileAllows(MANAGED_WORKFLOW_PROFILE, tool.id)).toBe(false)
      expect(profileAllows(PROPOSAL_WORKFLOW_PROFILE, tool.id)).toBe(false)
      expect(profileAllows(RUN_WORKFLOW_PROFILE, tool.id)).toBe(false)
      expect(profileAllows(AUTHORIZE_WORKFLOW_PROFILE, tool.id)).toBe(true)
    }
  })

  test("the authorize profile markdown carries the identical tool map, the feature-grant note, and no decision tools", () => {
    const markdown = readFileSync(join(import.meta.dir, "..", "profile", "managed-workflow-authorize.md"), "utf-8")
    expect(markdown).toContain('"*": false')
    for (const [toolId, enabled] of Object.entries(AUTHORIZE_WORKFLOW_PROFILE.tools)) {
      if (toolId === "*") continue
      expect(enabled).toBe(true)
      expect(markdown).toContain(`${toolId}: true`)
    }
    for (const forbidden of FORBIDDEN_TOOL_IDS) {
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      expect(markdown).not.toMatch(new RegExp(`^\\s*"?${escaped}"?: true`, "m"))
    }
    expect(markdown).not.toContain("workflow_run_start: true")
    expect(markdown).not.toContain("workflow_propose: true")
    expect(markdown).toContain("UNTRUSTED DATA")
    expect(markdown).toContain("grants the `authorize` feature")
    expect(markdown).toContain("REQUEST-ONLY")
  })

  test("the authorize profile prompt is request-only, human-gated, and carries the untrusted-content policy", () => {
    expect(AUTHORIZE_WORKFLOW_PROFILE.prompt).toContain("REQUEST an authorization")
    expect(AUTHORIZE_WORKFLOW_PROFILE.prompt).toContain("Authorizations panel")
    expect(AUTHORIZE_WORKFLOW_PROFILE.prompt).toContain("cannot grant, deny, revoke, or perform")
    expect(AUTHORIZE_WORKFLOW_PROFILE.prompt).toContain("only status 'consumed' means it was performed")
    expect(AUTHORIZE_WORKFLOW_PROFILE.prompt).toContain(UNTRUSTED_CONTENT_POLICY)
  })
})
