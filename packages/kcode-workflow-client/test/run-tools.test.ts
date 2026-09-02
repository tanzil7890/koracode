// Phase 12.8 step 4 tests: the scoped run tool surface — exact gateway
// paths/methods/bodies, feature-gated resolution (run tools resolve ONLY
// within the run surface), the bounded client-side wait (one token per poll,
// injectable sleep), and the profile posture (deny-by-default; publish/
// restore/schedule/approve/apply never exist anywhere).

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { ControlPlaneError, WorkflowControlPlaneClient } from "../src/client"
import {
  FORBIDDEN_TOOL_IDS,
  MANAGED_WORKFLOW_PROFILE,
  PROPOSAL_WORKFLOW_PROFILE,
  RUN_WORKFLOW_PROFILE,
  UNTRUSTED_CONTENT_POLICY,
  profileAllows,
} from "../src/profile"
import {
  RUN_ID_REQUIRED_CODE,
  RUN_WAIT_LIMITS,
  ToolDeniedError,
  WORKFLOW_PROPOSAL_TOOLS,
  WORKFLOW_READ_TOOLS,
  WORKFLOW_RUN_TOOLS,
  assertReadOnlySurface,
  missingRunIdResult,
  resolveFeatureTool,
  resolveProposalTool,
  resolveRunTool,
  resolveTool,
  toolsForFeatures,
  waitForRun,
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

/** A gateway RunResource with the contract's fields. */
function resource(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "run-77",
    agent_id: "agent-1",
    status: "running",
    trigger: "manual",
    engine: "kora",
    engine_version: "1",
    definition: { source: "published", version_number: 3, definition_digest: "sha256:d", labelled_non_production: false },
    control_state: { cancel_requested: false, pause_requested: false, paused_at: null },
    legal_controls: ["pause", "cancel"],
    waiting_request: null,
    current_node_id: "n1",
    termination_reason: null,
    outcome_label: null,
    error: null,
    output: null,
    created_at: "2026-09-01T00:00:00Z",
    started_at: "2026-09-01T00:00:01Z",
    finished_at: null,
    links: {
      self: "/runs/run-77/resource",
      events: "/runs/run-77/events",
      artifacts: "/runs/run-77/artifacts",
      controls: "/runs/run-77/controls",
      inputs: "/runs/run-77/inputs",
      capabilities: "/runs/run-77/capabilities",
    },
    ...overrides,
  }
}

function fakeSleep() {
  const sleeps: number[] = []
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) }
}

const RUN_TOOL_IDS = [
  "workflow_run_start",
  "workflow_run_list",
  "workflow_run_get",
  "workflow_run_control",
  "workflow_run_submit_input",
  "workflow_run_capabilities",
  "workflow_run_wait",
]

const ids = (tools: readonly { id: string }[]) => tools.map((tool) => tool.id)
const runTool = (id: string) => WORKFLOW_RUN_TOOLS.find((tool) => tool.id === id)!

describe("run client operations (wire contract)", () => {
  test("startRun POSTs /workflows/{agent_id}/runs with the exact body and returns the 202 resource", async () => {
    const { client, calls } = clientWith(() => Response.json(resource({ status: "queued" }), { status: 202 }))
    const out = (await client.startRun("agent-1", {
      idempotency_key: "t1:run",
      source: "published",
      variable_values: { NAME: "x" },
      turn_id: "t1",
    })) as Record<string, unknown>
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ url: `${BASE}/workflows/agent-1/runs`, method: "POST" })
    expect(calls[0]!.body).toEqual({ idempotency_key: "t1:run", source: "published", variable_values: { NAME: "x" }, turn_id: "t1" })
    expect(new Headers({ "content-type": "application/json" }).get("content-type")).toBe("application/json")
    expect(out["run_id"]).toBe("run-77")
    expect(out["status"]).toBe("queued")
  })

  test("listRuns GETs /workflows/{agent_id}/runs with only the page params given", async () => {
    const { client, calls } = clientWith(() => Response.json({ items: [resource()], next_cursor: null }))
    await client.listRuns("agent-1")
    expect(calls[0]).toMatchObject({ url: `${BASE}/workflows/agent-1/runs`, method: "GET" })
    await client.listRuns("agent-1", { cursor: "c1", limit: 10 })
    expect(calls[1]!.url).toBe(`${BASE}/workflows/agent-1/runs?cursor=c1&limit=10`)
    await client.listRuns("agent-1", { limit: 5 })
    expect(calls[2]!.url).toBe(`${BASE}/workflows/agent-1/runs?limit=5`)
  })

  test("runResource and runCapabilities GET their exact run paths", async () => {
    const { client, calls } = clientWith(() => Response.json(resource()))
    await client.runResource("run-77")
    expect(calls[0]).toMatchObject({ url: `${BASE}/runs/run-77/resource`, method: "GET" })
    await client.runCapabilities("run-77")
    expect(calls[1]).toMatchObject({ url: `${BASE}/runs/run-77/capabilities`, method: "GET" })
    expect(calls.every((call) => call.body === undefined)).toBe(true)
  })

  test("controlRun POSTs /runs/{run_id}/controls with the control body", async () => {
    const { client, calls } = clientWith(() =>
      Response.json(
        {
          command_id: "t1:pause",
          command: "pause",
          request_status: "accepted",
          effective_status: "pending",
          run_status: "running",
          reason: null,
          replayed: false,
        },
        { status: 202 },
      ),
    )
    const out = (await client.controlRun("run-77", { command: "pause", command_id: "t1:pause", expected_state: "running" })) as Record<string, unknown>
    expect(calls[0]).toMatchObject({ url: `${BASE}/runs/run-77/controls`, method: "POST" })
    expect(calls[0]!.body).toEqual({ command: "pause", command_id: "t1:pause", expected_state: "running" })
    expect(out["effective_status"]).toBe("pending") // passed through, never upgraded to "paused"
  })

  test("submitRunInput POSTs /runs/{run_id}/inputs with the input body", async () => {
    const { client, calls } = clientWith(() =>
      Response.json(
        { input_id: "t1:input", request_id: "req-1", run_id: "run-77", status: "accepted", answered_at: "2026-09-01T00:00:02Z", replayed: false },
        { status: 202 },
      ),
    )
    await client.submitRunInput("run-77", { input_id: "t1:input", request_id: "req-1", payload: { otp: "123456" } })
    expect(calls[0]).toMatchObject({ url: `${BASE}/runs/run-77/inputs`, method: "POST" })
    expect(calls[0]!.body).toEqual({ input_id: "t1:input", request_id: "req-1", payload: { otp: "123456" } })
  })

  test("ids are URL-encoded, never path-injected, and every call spends one fresh token", async () => {
    const { client, calls } = clientWith(() => Response.json(resource()))
    await client.runResource("../admin")
    expect(calls[0]!.url).toBe(`${BASE}/runs/..%2Fadmin/resource`)
    await client.startRun("a/b?c", { idempotency_key: "k" })
    expect(calls[1]!.url).toBe(`${BASE}/workflows/a%2Fb%3Fc/runs`)
    await client.runCapabilities("run-77")
    expect(calls.map((call) => call.token)).toEqual(["tok-1", "tok-2", "tok-3"])
  })

  test("a {detail:{code,message}} gateway error surfaces its code and keeps the status prefix", async () => {
    const { client } = clientWith(() =>
      Response.json({ detail: { code: "NO_PUBLISHED_VERSION", message: "no published version" } }, { status: 409 }),
    )
    const error = (await client.startRun("agent-1", { idempotency_key: "k" }).catch((e: unknown) => e)) as ControlPlaneError
    expect(error).toBeInstanceOf(ControlPlaneError)
    expect(error.status).toBe(409)
    expect(error.code).toBe("NO_PUBLISHED_VERSION")
    expect(error.detail).toBe("no published version")
    expect(error.message).toBe("gateway returned 409 (NO_PUBLISHED_VERSION: no published version)")
  })

  test("string details and non-JSON bodies still produce the historical message", async () => {
    const plain = clientWith(() => new Response("denied", { status: 403 }))
    const plainError = (await plain.client.runResource("r").catch((e: unknown) => e)) as ControlPlaneError
    expect(plainError.message).toBe("gateway returned 403")
    expect(plainError.code).toBeUndefined()

    const stringDetail = clientWith(() => Response.json({ detail: "Gateway requires DATABASE_URL" }, { status: 503 }))
    const stringError = (await stringDetail.client.runResource("r").catch((e: unknown) => e)) as ControlPlaneError
    expect(stringError.message).toBe("gateway returned 503 (error: Gateway requires DATABASE_URL)")
    expect(stringError.code).toBeUndefined()
    expect(stringError.detail).toBe("Gateway requires DATABASE_URL")
  })

  test("the client has NO publish, restore, schedule, approve, or apply method", () => {
    const surface = Object.getOwnPropertyNames(WorkflowControlPlaneClient.prototype)
    expect(surface.some((name) => /approve|apply|publish|restore|schedule/i.test(name))).toBe(false)
    for (const method of ["startRun", "listRuns", "runResource", "controlRun", "submitRunInput", "runCapabilities"]) {
      expect(surface).toContain(method)
    }
  })
})

describe("run tool surface", () => {
  test("WORKFLOW_RUN_TOOLS are exactly the seven scoped run tools with closed schemas", () => {
    expect(ids(WORKFLOW_RUN_TOOLS)).toEqual(RUN_TOOL_IDS)
    for (const tool of WORKFLOW_RUN_TOOLS) {
      const schema = tool.parameters as { additionalProperties?: boolean; required?: string[] }
      expect(schema.additionalProperties).toBe(false)
      expect(schema.required?.some((field) => field === "run_id" || field === "agent_id")).toBe(true)
    }
    expect(runTool("workflow_run_start").description).toContain("SAVED workflow")
    expect(runTool("workflow_run_start").description).toContain("independently of this chat")
    expect(runTool("workflow_run_control").description).toContain("effective_status")
    expect(runTool("workflow_run_control").description).toContain("'unsupported'")
    expect(runTool("workflow_run_submit_input").description).toContain("waiting_request")
  })

  test("resolveRunTool serves read + run tools and denies proposal, mutation, and host tools", () => {
    for (const tool of WORKFLOW_RUN_TOOLS) expect(resolveRunTool(tool.id).id).toBe(tool.id)
    for (const tool of WORKFLOW_READ_TOOLS) expect(resolveRunTool(tool.id).id).toBe(tool.id)
    for (const denied of [
      "workflow_propose",
      "workflow_validate_proposal",
      "workflow_proposal_status",
      "workflow_publish",
      "workflow_restore",
      "workflow_schedule",
      "workflow_approve",
      "workflow_apply",
      "bash",
      "edit",
      "browser_execute",
      "Workflow_Run_Start",
    ]) {
      expect(() => resolveRunTool(denied)).toThrow(ToolDeniedError)
    }
  })

  test("the proposal and read-only resolvers do NOT gain run tools", () => {
    for (const tool of WORKFLOW_RUN_TOOLS) {
      expect(() => resolveProposalTool(tool.id)).toThrow(ToolDeniedError)
      expect(() => resolveTool(tool.id)).toThrow(ToolDeniedError)
    }
  })

  test("toolsForFeatures / resolveFeatureTool unlock exactly the granted lists", () => {
    expect(ids(toolsForFeatures([]))).toEqual(ids(WORKFLOW_READ_TOOLS))
    expect(ids(toolsForFeatures(["propose"]))).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS]))
    expect(ids(toolsForFeatures(["run"]))).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_RUN_TOOLS]))
    expect(ids(toolsForFeatures(["propose", "run"]))).toEqual(
      ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS, ...WORKFLOW_RUN_TOOLS]),
    )
    expect(ids(toolsForFeatures(["admin", "publish"]))).toEqual(ids(WORKFLOW_READ_TOOLS)) // unknown grants unlock nothing
    expect(resolveFeatureTool(["run"], "workflow_run_start").id).toBe("workflow_run_start")
    expect(() => resolveFeatureTool(["propose"], "workflow_run_start")).toThrow(ToolDeniedError)
    expect(() => resolveFeatureTool(["run"], "workflow_propose")).toThrow(ToolDeniedError)
    expect(() => resolveFeatureTool(["propose", "run"], "workflow_publish")).toThrow(ToolDeniedError)
  })

  test("assertReadOnlySurface still rejects a build that registers run tools", () => {
    expect(() => assertReadOnlySurface([...ids(WORKFLOW_READ_TOOLS), "workflow_run_start"])).toThrow(ToolDeniedError)
    expect(() => assertReadOnlySurface(ids(WORKFLOW_READ_TOOLS))).not.toThrow()
  })

  test("tool executes map their args onto the exact client calls", async () => {
    const { client, calls } = clientWith(() => Response.json(resource(), { status: 202 }))
    await runTool("workflow_run_start").execute(client, {
      agent_id: "agent-1",
      idempotency_key: "t1:run",
      source: "version",
      version_number: 2,
      variable_values: { A: 1 },
      turn_id: "t1",
    })
    expect(calls[0]).toMatchObject({ url: `${BASE}/workflows/agent-1/runs`, method: "POST" })
    expect(calls[0]!.body).toEqual({ idempotency_key: "t1:run", source: "version", version_number: 2, variable_values: { A: 1 }, turn_id: "t1" })

    await runTool("workflow_run_start").execute(client, { agent_id: "agent-1", idempotency_key: "t1:run" })
    expect(calls[1]!.body).toEqual({ idempotency_key: "t1:run", source: "published" }) // the default is explicit on the wire

    await runTool("workflow_run_start").execute(client, { agent_id: "agent-1", idempotency_key: "k", source: "draft" })
    expect((calls[2]!.body as Record<string, unknown>)["source"]).toBe("draft") // never coerced; the gateway rejects it

    await runTool("workflow_run_list").execute(client, { agent_id: "agent-1", cursor: "c9", limit: 5 })
    expect(calls[3]).toMatchObject({ url: `${BASE}/workflows/agent-1/runs?cursor=c9&limit=5`, method: "GET" })

    await runTool("workflow_run_get").execute(client, { run_id: "run-77" })
    expect(calls[4]).toMatchObject({ url: `${BASE}/runs/run-77/resource`, method: "GET" })

    await runTool("workflow_run_control").execute(client, { run_id: "run-77", command: "cancel", command_id: "t1:cancel", expected_state: "running" })
    expect(calls[5]).toMatchObject({ url: `${BASE}/runs/run-77/controls`, method: "POST" })
    expect(calls[5]!.body).toEqual({ command: "cancel", command_id: "t1:cancel", expected_state: "running" })

    await runTool("workflow_run_submit_input").execute(client, { run_id: "run-77", input_id: "t1:input", request_id: "req-1", payload: ["a", 1] })
    expect(calls[6]).toMatchObject({ url: `${BASE}/runs/run-77/inputs`, method: "POST" })
    expect(calls[6]!.body).toEqual({ input_id: "t1:input", request_id: "req-1", payload: ["a", 1] })

    await runTool("workflow_run_capabilities").execute(client, { run_id: "run-77" })
    expect(calls[7]).toMatchObject({ url: `${BASE}/runs/run-77/capabilities`, method: "GET" })
  })
})

describe("workflow_run_wait (bounded client-side polling)", () => {
  test("stops at the first terminal resource: one token per poll, sleeping only between polls", async () => {
    const statuses = ["running", "running", "completed"]
    const { client, calls } = clientWith((_url, call) => Response.json(resource({ status: statuses[call - 1] })))
    const { sleeps, sleep } = fakeSleep()
    const result = await waitForRun(client, { run_id: "run-77", max_polls: 4, interval_ms: 1000 }, { sleep })
    expect(result.reason).toBe("terminal")
    expect(result.polls).toBe(3)
    expect(result.waited_ms).toBe(2000)
    expect((result.resource as Record<string, unknown>)["status"]).toBe("completed")
    expect(sleeps).toEqual([1000, 1000])
    expect(calls.map((call) => call.url)).toEqual(Array(3).fill(`${BASE}/runs/run-77/resource`))
    expect(calls.map((call) => call.token)).toEqual(["tok-1", "tok-2", "tok-3"]) // one fresh token per poll
  })

  test.each(["failed", "cancelled"])("'%s' is terminal too", async (status) => {
    const { client } = clientWith(() => Response.json(resource({ status })))
    const result = await waitForRun(client, { run_id: "run-77" }, fakeSleep())
    expect(result).toMatchObject({ reason: "terminal", polls: 1, waited_ms: 0 })
  })

  test("stops when the run pauses", async () => {
    const statuses = ["running", "paused"]
    const { client, calls } = clientWith((_url, call) => Response.json(resource({ status: statuses[call - 1] })))
    const { sleeps, sleep } = fakeSleep()
    const result = await waitForRun(client, { run_id: "run-77", interval_ms: 2000 }, { sleep })
    expect(result).toMatchObject({ reason: "paused", polls: 2, waited_ms: 2000 })
    expect(sleeps).toEqual([2000])
    expect(calls).toHaveLength(2)
  })

  test("stops when a waiting_request appears, and that beats 'paused'", async () => {
    const waiting = { request_id: "req-1", schema: { type: "object" }, prompt: "Enter the OTP", expires_at: "2026-09-01T00:10:00Z" }
    const running = clientWith(() => Response.json(resource({ status: "running", waiting_request: waiting })))
    const { sleeps, sleep } = fakeSleep()
    expect(await waitForRun(running.client, { run_id: "run-77" }, { sleep })).toMatchObject({ reason: "waiting_input", polls: 1, waited_ms: 0 })
    expect(sleeps).toEqual([])

    const paused = clientWith(() => Response.json(resource({ status: "paused", waiting_request: waiting })))
    expect((await waitForRun(paused.client, { run_id: "run-77" }, fakeSleep())).reason).toBe("waiting_input")
  })

  test("times out after the clamped poll budget and returns the last resource", async () => {
    const { client, calls } = clientWith(() => Response.json(resource({ status: "running" })))
    const { sleeps, sleep } = fakeSleep()
    const result = await waitForRun(client, { run_id: "run-77", max_polls: 99, interval_ms: 50 }, { sleep })
    expect(result.reason).toBe("timeout")
    expect(result.polls).toBe(RUN_WAIT_LIMITS.maxPolls) // 99 → 6
    expect(sleeps).toEqual(Array(RUN_WAIT_LIMITS.maxPolls - 1).fill(RUN_WAIT_LIMITS.minIntervalMs)) // 50 → 1000, never after the last poll
    expect(result.waited_ms).toBe((RUN_WAIT_LIMITS.maxPolls - 1) * RUN_WAIT_LIMITS.minIntervalMs)
    expect((result.resource as Record<string, unknown>)["status"]).toBe("running")
    expect(calls).toHaveLength(RUN_WAIT_LIMITS.maxPolls)
  })

  test("defaults are 4 polls at 5000 ms; bad bounds fall back, fractions truncate, and the ceiling is 10000 ms", async () => {
    const { client } = clientWith(() => Response.json(resource({ status: "queued" })))
    const defaults = fakeSleep()
    const result = await waitForRun(client, { run_id: "run-77" }, defaults)
    expect(result).toMatchObject({ reason: "timeout", polls: RUN_WAIT_LIMITS.defaultPolls, waited_ms: 3 * RUN_WAIT_LIMITS.defaultIntervalMs })
    expect(defaults.sleeps).toEqual([5000, 5000, 5000])

    const bad = fakeSleep()
    expect((await waitForRun(client, { run_id: "run-77", max_polls: "abc", interval_ms: null }, bad)).polls).toBe(4)
    expect(bad.sleeps).toEqual([5000, 5000, 5000])

    const fractional = fakeSleep()
    expect((await waitForRun(client, { run_id: "run-77", max_polls: 2.9, interval_ms: 99_999 }, fractional)).polls).toBe(2)
    expect(fractional.sleeps).toEqual([RUN_WAIT_LIMITS.maxIntervalMs])

    const floor = fakeSleep()
    expect((await waitForRun(client, { run_id: "run-77", max_polls: 0 }, floor)).polls).toBe(1)
    expect(floor.sleeps).toEqual([])
  })

  test("a failing poll propagates (the responder turns it into data) after spending only the polls made", async () => {
    const { client, calls } = clientWith((_url, call) =>
      call === 2 ? Response.json({ detail: { code: "RUN_NOT_FOUND", message: "gone" } }, { status: 404 }) : Response.json(resource()),
    )
    await expect(waitForRun(client, { run_id: "run-77", max_polls: 4, interval_ms: 1000 }, fakeSleep())).rejects.toThrow(ControlPlaneError)
    expect(calls).toHaveLength(2)
  })

  test("the tool descriptor forwards the responder's context (injectable sleep)", async () => {
    const statuses = ["running", "completed"]
    const { client } = clientWith((_url, call) => Response.json(resource({ status: statuses[call - 1] })))
    const { sleeps, sleep } = fakeSleep()
    const result = (await runTool("workflow_run_wait").execute(client, { run_id: "run-77", max_polls: 3, interval_ms: 1500 }, { sleep })) as {
      reason: string
      polls: number
    }
    expect(result).toMatchObject({ reason: "terminal", polls: 2 })
    expect(sleeps).toEqual([1500])
  })
})

describe("run profile posture", () => {
  test("RUN_WORKFLOW_PROFILE is deny-by-default and allows exactly the read + run tools", () => {
    expect(RUN_WORKFLOW_PROFILE.tools["*"]).toBe(false)
    const allowed = Object.entries(RUN_WORKFLOW_PROFILE.tools)
      .filter(([, enabled]) => enabled)
      .map(([id]) => id)
      .sort()
    expect(allowed).toEqual(ids([...WORKFLOW_READ_TOOLS, ...WORKFLOW_RUN_TOOLS]).sort())
    expect(profileAllows(RUN_WORKFLOW_PROFILE, "workflow_propose")).toBe(false)
    expect(profileAllows(RUN_WORKFLOW_PROFILE, "some_new_tool_2027")).toBe(false)
    expect(RUN_WORKFLOW_PROFILE.environment).toBe(MANAGED_WORKFLOW_PROFILE.environment)
  })

  test("publish/restore/schedule/approve/apply are forbidden ids and denied by every profile", () => {
    for (const id of [
      "workflow_publish",
      "workflow_restore",
      "workflow_schedule",
      "workflow_approve",
      "workflow_apply",
      "publish",
      "restore",
      "schedule",
      "approve",
      "apply",
    ]) {
      expect(FORBIDDEN_TOOL_IDS).toContain(id)
    }
    for (const id of FORBIDDEN_TOOL_IDS) {
      expect(profileAllows(MANAGED_WORKFLOW_PROFILE, id)).toBe(false)
      expect(profileAllows(PROPOSAL_WORKFLOW_PROFILE, id)).toBe(false)
      expect(profileAllows(RUN_WORKFLOW_PROFILE, id)).toBe(false)
    }
  })

  test("run tools are NOT granted by the read-only or proposal profiles", () => {
    for (const tool of WORKFLOW_RUN_TOOLS) {
      expect(profileAllows(MANAGED_WORKFLOW_PROFILE, tool.id)).toBe(false)
      expect(profileAllows(PROPOSAL_WORKFLOW_PROFILE, tool.id)).toBe(false)
      expect(profileAllows(RUN_WORKFLOW_PROFILE, tool.id)).toBe(true)
    }
  })

  test("the run profile markdown carries the identical tool map, the feature-grant note, and no mutation tools", () => {
    const markdown = readFileSync(join(import.meta.dir, "..", "profile", "managed-workflow-run.md"), "utf-8")
    expect(markdown).toContain('"*": false')
    for (const [toolId, enabled] of Object.entries(RUN_WORKFLOW_PROFILE.tools)) {
      if (toolId === "*") continue
      expect(enabled).toBe(true)
      expect(markdown).toContain(`${toolId}: true`)
    }
    // Line-anchored: the frontmatter key must not BE a forbidden id (a plain
    // substring check would trip on `workflow_run_list` containing `list`).
    for (const forbidden of FORBIDDEN_TOOL_IDS) {
      const escaped = forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      expect(markdown).not.toMatch(new RegExp(`^\\s*"?${escaped}"?: true`, "m"))
    }
    expect(markdown).not.toContain("workflow_propose: true")
    expect(markdown).toContain("UNTRUSTED DATA")
    expect(markdown).toContain("grants the `run` feature")
  })

  test("the run profile prompt is explicit-only, effective_status-gated, and carries the untrusted-content policy", () => {
    expect(RUN_WORKFLOW_PROFILE.prompt).toContain("ONLY when the user explicitly asks")
    expect(RUN_WORKFLOW_PROFILE.prompt).toContain("published version by default")
    expect(RUN_WORKFLOW_PROFILE.prompt).toContain("effective_status 'effective'")
    expect(RUN_WORKFLOW_PROFILE.prompt).toContain("cannot change the workflow definition")
    expect(RUN_WORKFLOW_PROFILE.prompt).toContain(UNTRUSTED_CONTENT_POLICY)
  })
})

describe("confirmation-gated start and the local run_id guard (12.8 step 7)", () => {
  const REQUESTED_START = {
    status: "requested",
    subject_kind: "run.start",
    authorization_id: "auth-run-1",
    expires_at: "2026-09-03T00:00:00Z",
    binding: { agent_id: "agent-1", source: "published", version_number: 3, definition_digest: "sha256:d", variable_values: {} },
    run_id: null,
    replayed: false,
  }

  test("client-level: nothing changes on the wire — a 'requested' 202 body is passed through verbatim", async () => {
    const { client, calls } = clientWith(() => Response.json(REQUESTED_START, { status: 202 }))
    const out = await client.startRun("agent-1", { idempotency_key: "t1:run", source: "published", turn_id: "t1" })
    expect(calls[0]).toMatchObject({ url: `${BASE}/workflows/agent-1/runs`, method: "POST" })
    expect(calls[0]!.body).toEqual({ idempotency_key: "t1:run", source: "published", turn_id: "t1" })
    expect(out).toEqual(REQUESTED_START) // the client interprets nothing; the responder does
  })

  test("the start tool also passes a 'requested' result through untouched (the reminder is the responder's)", async () => {
    const { client } = clientWith(() => Response.json(REQUESTED_START, { status: 202 }))
    const out = await runTool("workflow_run_start").execute(client, { agent_id: "agent-1", idempotency_key: "t1:run" })
    expect(out).toEqual(REQUESTED_START)
  })

  test.each(["workflow_run_wait", "workflow_run_get", "workflow_run_control", "workflow_run_submit_input", "workflow_run_capabilities"])(
    "%s with a null, missing, or empty run_id is refused locally with an error object and no gateway call",
    async (toolId) => {
      const { client, calls } = clientWith(() => Response.json(resource()))
      const extras = { command: "cancel", command_id: "t1:cancel", input_id: "t1:input", request_id: "req-1", payload: {}, max_polls: 3 }
      for (const runId of [null, undefined, ""]) {
        const result = (await runTool(toolId).execute(client, { ...extras, run_id: runId }, fakeSleep())) as Record<string, unknown>
        expect(result).toEqual(missingRunIdResult(toolId))
        expect(result["code"]).toBe(RUN_ID_REQUIRED_CODE)
        expect(result["tool"]).toBe(toolId)
        expect(String(result["error"])).toBe(`RunIdRequired: ${toolId} needs a run_id`)
        expect(String(result["message"])).toContain("has NOT started")
      }
      expect(calls).toEqual([]) // never a URL built from 'null'/'undefined', never a token spent
      // With a real run id the same tool still reaches the gateway.
      await runTool(toolId).execute(client, { ...extras, run_id: "run-77", max_polls: 1 }, fakeSleep())
      expect(calls).toHaveLength(1)
      expect(calls[0]!.url).toContain(`${BASE}/runs/run-77/`)
    },
  )

  test("waitForRun itself is unchanged when given a run id", async () => {
    const { client, calls } = clientWith(() => Response.json(resource({ status: "completed" })))
    const result = await waitForRun(client, { run_id: "run-77" }, fakeSleep())
    expect(result).toMatchObject({ reason: "terminal", polls: 1 })
    expect(calls).toHaveLength(1)
  })

  test("the start tool description explains both 202 shapes; wait/get descriptions demand a real run_id", () => {
    expect(runTool("workflow_run_start").description).toContain("status:'requested'")
    expect(runTool("workflow_run_start").description).toContain("has NOT started until a human confirms it")
    expect(runTool("workflow_run_wait").description).toContain("Requires a real run_id")
    expect(runTool("workflow_run_get").description).toContain("Requires a real run_id")
  })
})
