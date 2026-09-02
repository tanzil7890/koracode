// The exact workflow tool surface — Phase 12.4 steps 6/7/13, extended in
// 12.6 (proposal tools), 12.8 step 4 (scoped run tools), and 12.8 step 7
// (request-only authorization tools).
//
// Four feature-gated lists over WorkflowControlPlaneClient: the six read
// tools (always), the proposal tools (feature 'propose'), the run tools
// (feature 'run'), and the authorization tools (feature 'authorize').
// Anything not in these lists does not exist for the managed profile: there
// is no bash, no write/edit/patch, no generic fetch/search, no MCP
// passthrough, no raw browser_execute, no cookie/storage access, no host
// process surface — and no publish/restore/schedule/set-live/approve/apply/
// grant, because the client has no such methods to call.

import type { AuthorizationSubjectKind, RunControlCommand, RunSource, WorkflowControlPlaneClient } from "./client"

/** Per-call context the responder may hand a tool. Only client-side polling
 * uses it (an injectable sleep keeps the wait bounded AND testable). */
export interface ToolContext {
  readonly sleep?: (ms: number) => Promise<void>
}

export interface WorkflowToolDescriptor {
  readonly id: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (
    client: WorkflowControlPlaneClient,
    args: Record<string, unknown>,
    context?: ToolContext,
  ) => Promise<unknown>
}

export class ToolDeniedError extends Error {
  constructor(toolId: string) {
    super(`tool '${toolId}' is not available in the managed workflow profile`)
    this.name = "ToolDeniedError"
  }
}

const agentIdParam = {
  type: "object",
  properties: { agent_id: { type: "string", description: "The workflow agent id" } },
  required: ["agent_id"],
  additionalProperties: false,
} as const

const runIdParam = {
  type: "object",
  properties: { run_id: { type: "string", description: "The workflow run id" } },
  required: ["run_id"],
  additionalProperties: false,
} as const

export const WORKFLOW_READ_TOOLS: readonly WorkflowToolDescriptor[] = [
  {
    id: "workflow_head",
    description: "Read the current saved workflow graph (head revision) for an agent.",
    parameters: agentIdParam,
    execute: (client, args) => client.workflowHead(String(args["agent_id"])),
  },
  {
    id: "workflow_revisions",
    description: "List recent workflow graph revisions for an agent.",
    parameters: agentIdParam,
    execute: (client, args) => client.workflowRevisions(String(args["agent_id"])),
  },
  {
    id: "workflow_versions",
    description: "List published workflow versions for an agent.",
    parameters: agentIdParam,
    execute: (client, args) => client.workflowVersions(String(args["agent_id"])),
  },
  {
    id: "workflow_run_status",
    description: "Read one workflow run's status, terminal reason, and outcome.",
    parameters: runIdParam,
    execute: (client, args) => client.runStatus(String(args["run_id"])),
  },
  {
    id: "workflow_run_events",
    description: "Read a workflow run's event stream after a cursor.",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        after_seq: { type: "integer", minimum: 0, default: 0 },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
    execute: (client, args) => client.runEvents(String(args["run_id"]), Number(args["after_seq"] ?? 0)),
  },
  {
    id: "workflow_run_artifacts",
    description: "Read a workflow run's artifact manifest (metadata only, never bytes).",
    parameters: runIdParam,
    execute: (client, args) => client.runArtifacts(String(args["run_id"])),
  },
]

/** Phase 12.6: proposal tools — get/validate/propose/diff only. Approve and
 * apply do not exist on the client, so this surface still cannot mutate
 * canonical state; the gateway additionally requires the propose scope. */
export const WORKFLOW_PROPOSAL_TOOLS: readonly WorkflowToolDescriptor[] = [
  {
    id: "workflow_validate_proposal",
    description: "Dry-run validate a candidate workflow graph: schema/graph rules, semantic diff, and risk — no row is written.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        candidate_graph: { type: "object" },
      },
      required: ["agent_id", "candidate_graph"],
      additionalProperties: false,
    },
    execute: (client, args) =>
      client.validateProposal(String(args["agent_id"]), (args["candidate_graph"] ?? {}) as Record<string, unknown>),
  },
  {
    id: "workflow_propose",
    description:
      "Create a change-set PROPOSAL bound to the exact base generation/hash. Canonical state does not change; a human must approve/apply.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        base_generation: { type: "integer", minimum: 0 },
        base_hash: { type: "string" },
        candidate_graph: { type: "object" },
        patch_ops: { type: "array", items: { type: "object" }, maxItems: 50 },
        idempotency_key: { type: "string" },
      },
      required: ["agent_id", "base_generation", "base_hash", "idempotency_key"],
      additionalProperties: false,
    },
    execute: (client, args) =>
      client.propose(String(args["agent_id"]), {
        base_generation: Number(args["base_generation"]),
        base_hash: String(args["base_hash"]),
        candidate_graph: args["candidate_graph"] as Record<string, unknown> | undefined,
        patch_ops: args["patch_ops"] as Record<string, unknown>[] | undefined,
        idempotency_key: String(args["idempotency_key"]),
      }),
  },
  {
    id: "workflow_proposal_status",
    description: "Read one change set's status, semantic diff, and risk classification.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        change_set_id: { type: "string" },
      },
      required: ["agent_id", "change_set_id"],
      additionalProperties: false,
    },
    execute: (client, args) => client.proposalStatus(String(args["agent_id"]), String(args["change_set_id"])),
  },
]

// ---- Phase 12.8 step 4: scoped run tools (feature 'run') ----
//
// Runs execute the SAVED definition; nothing here edits it. Controls and
// inputs are requests the runtime may honor, decline, or not support — the
// tool results carry that verdict literally and the model must repeat it.

/** Run statuses after which the resource no longer changes. */
export const TERMINAL_RUN_STATUSES: readonly string[] = ["completed", "failed", "cancelled"]

/** Bounds for workflow_run_wait — every poll spends one one-use gateway token. */
export const RUN_WAIT_LIMITS = {
  minPolls: 1,
  maxPolls: 6,
  defaultPolls: 4,
  minIntervalMs: 1_000,
  maxIntervalMs: 10_000,
  defaultIntervalMs: 5_000,
} as const

export type RunWaitReason = "terminal" | "paused" | "waiting_input" | "timeout"

export interface RunWaitResult {
  /** The last run resource read (the gateway's RunResource). */
  readonly resource: unknown
  readonly polls: number
  /** Sum of the intervals actually slept between polls (never after the last). */
  readonly waited_ms: number
  readonly reason: RunWaitReason
}

const RUN_SOURCES: readonly string[] = ["published", "version", "draft_snapshot"]
const RUN_CONTROL_COMMANDS: readonly string[] = ["pause", "resume", "cancel"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value)
  if (value === undefined || value === null || !Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** Why polling may stop early: terminal beats waiting_input beats paused
 * (a declared waiting_request is the more actionable fact than 'paused'). */
function settledReason(resource: unknown): Exclude<RunWaitReason, "timeout"> | undefined {
  if (!isRecord(resource)) return undefined
  const status = String(resource["status"] ?? "")
  if (TERMINAL_RUN_STATUSES.includes(status)) return "terminal"
  if (resource["waiting_request"] !== null && resource["waiting_request"] !== undefined) return "waiting_input"
  if (status === "paused") return "paused"
  return undefined
}

/** Client-side bounded wait: poll GET /runs/{id}/resource until the run is
 * terminal, paused, or waiting for input — or the (clamped) poll budget runs
 * out. One gateway token per poll; the sleep is injectable for tests. Errors
 * from a poll propagate untouched (the responder turns them into data). */
export async function waitForRun(
  client: WorkflowControlPlaneClient,
  args: Record<string, unknown>,
  context: ToolContext = {},
): Promise<RunWaitResult> {
  const runId = String(args["run_id"])
  const maxPolls = clampInt(args["max_polls"], RUN_WAIT_LIMITS.minPolls, RUN_WAIT_LIMITS.maxPolls, RUN_WAIT_LIMITS.defaultPolls)
  const intervalMs = clampInt(
    args["interval_ms"],
    RUN_WAIT_LIMITS.minIntervalMs,
    RUN_WAIT_LIMITS.maxIntervalMs,
    RUN_WAIT_LIMITS.defaultIntervalMs,
  )
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  let waited = 0
  let resource: unknown = null
  for (let poll = 1; poll <= maxPolls; poll++) {
    resource = await client.runResource(runId)
    const reason = settledReason(resource)
    if (reason) return { resource, polls: poll, waited_ms: waited, reason }
    if (poll < maxPolls) {
      await sleep(intervalMs)
      waited += intervalMs
    }
  }
  return { resource, polls: maxPolls, waited_ms: waited, reason: "timeout" }
}

export const WORKFLOW_RUN_TOOLS: readonly WorkflowToolDescriptor[] = [
  {
    id: "workflow_run_start",
    description:
      "Start a durable run of the SAVED workflow — the published version by default (source 'published'; 'version' with " +
      "version_number for a specific published version; 'draft_snapshot' for the current unpublished draft). Returns 202 " +
      "with the run resource (run_id, status, legal_controls, links); the run continues independently of this chat. " +
      "idempotency_key is required and must be unique per intended run — repeating a key replays the same run. " +
      "An error with code NO_PUBLISHED_VERSION means there is nothing published: offer source 'draft_snapshot' instead of retrying.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The workflow agent id" },
        idempotency_key: { type: "string", description: "Unique per intended run; a repeat replays the same run." },
        source: { type: "string", enum: [...RUN_SOURCES], default: "published" },
        version_number: { type: "integer", minimum: 1, description: "Only with source 'version'." },
        variable_values: { type: "object", description: "Values for the workflow's declared variables." },
      },
      required: ["agent_id", "idempotency_key"],
      additionalProperties: false,
    },
    execute: (client, args) => {
      // The default is made explicit on the wire; an unknown source string is
      // passed through for the gateway to reject (never silently coerced to
      // 'published' — that could run the wrong definition).
      const source = optionalString(args["source"])
      const versionNumber = Number(args["version_number"])
      return client.startRun(String(args["agent_id"]), {
        idempotency_key: String(args["idempotency_key"]),
        source: (source ?? "published") as RunSource,
        ...(Number.isInteger(versionNumber) && versionNumber > 0 ? { version_number: versionNumber } : {}),
        ...(isRecord(args["variable_values"]) ? { variable_values: args["variable_values"] } : {}),
        ...(optionalString(args["turn_id"]) ? { turn_id: String(args["turn_id"]) } : {}),
      })
    },
  },
  {
    id: "workflow_run_list",
    description: "List an agent's runs (newest first) as run resources, with a cursor for the next page.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "The workflow agent id" },
        cursor: { type: "string", description: "next_cursor from the previous page." },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    execute: (client, args) => {
      const limit = Number(args["limit"])
      return client.listRuns(String(args["agent_id"]), {
        ...(optionalString(args["cursor"]) ? { cursor: String(args["cursor"]) } : {}),
        ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
      })
    },
  },
  {
    id: "workflow_run_get",
    description:
      "Read one run's full resource: status, definition source/version, control_state, legal_controls (the only controls " +
      "the runtime can honor right now), waiting_request (a declared input request, or null), outcome, error, output, links.",
    parameters: runIdParam,
    execute: (client, args) => client.runResource(String(args["run_id"])),
  },
  {
    id: "workflow_run_control",
    description:
      "Request pause, resume, or cancel on a run. Accepted ≠ effective: report the result's effective_status LITERALLY — " +
      "'effective' means it happened, 'pending' means requested but not yet applied, 'unsupported' means the runtime cannot " +
      "do it, 'failed' means it did not happen. Only commands listed in the run's legal_controls can take effect. " +
      "command_id must be unique per request (a repeat replays the earlier result).",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The workflow run id" },
        command: { type: "string", enum: [...RUN_CONTROL_COMMANDS] },
        command_id: { type: "string", description: "Unique per control request." },
        expected_state: { type: "string", description: "Optional run status the command assumes; rejected if it changed." },
      },
      required: ["run_id", "command", "command_id"],
      additionalProperties: false,
    },
    execute: (client, args) =>
      client.controlRun(String(args["run_id"]), {
        command: String(args["command"]) as RunControlCommand,
        command_id: String(args["command_id"]),
        ...(optionalString(args["expected_state"]) ? { expected_state: String(args["expected_state"]) } : {}),
      }),
  },
  {
    id: "workflow_run_submit_input",
    description:
      "Answer a run's DECLARED waiting_request (use its request_id from the run resource). This only answers a request " +
      "the run itself raised; it is never a channel to steer, instruct, or modify the run.",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The workflow run id" },
        input_id: { type: "string", description: "Unique per submission (a repeat replays)." },
        request_id: { type: "string", description: "The waiting_request.request_id being answered." },
        payload: { description: "The answer, shaped by waiting_request.schema." },
        expected_state: { type: "string" },
      },
      required: ["run_id", "input_id", "request_id", "payload"],
      additionalProperties: false,
    },
    execute: (client, args) =>
      client.submitRunInput(String(args["run_id"]), {
        input_id: String(args["input_id"]),
        request_id: String(args["request_id"]),
        payload: args["payload"],
        ...(optionalString(args["expected_state"]) ? { expected_state: String(args["expected_state"]) } : {}),
      }),
  },
  {
    id: "workflow_run_capabilities",
    description: "Read what the run's backend supports (pause/resume/cancel/input requests) before requesting a control.",
    parameters: runIdParam,
    execute: (client, args) => client.runCapabilities(String(args["run_id"])),
  },
  {
    id: "workflow_run_wait",
    description:
      "Bounded client-side wait: poll the run resource until status is terminal (completed/failed/cancelled), paused, or a " +
      "waiting_request appears — or max_polls (1..6, default 4) at interval_ms (1000..10000, default 5000) run out. Returns " +
      "the last resource plus {polls, waited_ms, reason: 'terminal'|'paused'|'waiting_input'|'timeout'}. Every poll spends " +
      "one gateway token, so call it at most once per turn.",
    parameters: {
      type: "object",
      properties: {
        run_id: { type: "string", description: "The workflow run id" },
        max_polls: { type: "integer", minimum: RUN_WAIT_LIMITS.minPolls, maximum: RUN_WAIT_LIMITS.maxPolls, default: RUN_WAIT_LIMITS.defaultPolls },
        interval_ms: {
          type: "integer",
          minimum: RUN_WAIT_LIMITS.minIntervalMs,
          maximum: RUN_WAIT_LIMITS.maxIntervalMs,
          default: RUN_WAIT_LIMITS.defaultIntervalMs,
        },
      },
      required: ["run_id"],
      additionalProperties: false,
    },
    execute: (client, args, context) => waitForRun(client, args, context),
  },
]

// ---- Phase 12.8 step 7: request-only authorization tools (feature 'authorize') ----
//
// A protected product operation (publish, restore, set live, schedule
// update/delete, batch cancel) is never performed from here. The model may
// only REQUEST an authorization for it; a human grants it in the product's
// Authorizations panel and the operation runs when that grant is consumed
// server-side. There is no grant/deny/revoke tool because the gateway has no
// such route — and the reminder attached to every result keeps the model
// from narrating a request as a completed operation.

export const AUTHORIZATION_SUBJECT_KINDS: readonly AuthorizationSubjectKind[] = [
  "workflow.publish",
  "workflow.restore",
  "workflow.set_live",
  "schedule.update",
  "schedule.delete",
  "batch.cancel",
]

export const AUTHORIZATION_STATUSES: readonly string[] = [
  "requested",
  "granted",
  "consumed",
  "denied",
  "expired",
  "revoked",
  "superseded",
  "failed",
]

/** The literal, status-keyed reminder attached to every authorization view
 * the model sees. Only 'consumed' means the operation happened. */
export function authorizationReminder(status: unknown): string {
  switch (status) {
    case "requested":
      return (
        "status 'requested' means a human must grant this in the product's Authorizations panel; the operation has NOT " +
        "happened — never say it has."
      )
    case "granted":
      return (
        "status 'granted' means a human approved it, but the operation has NOT run yet (it runs when the grant is " +
        "consumed) — do not claim it happened."
      )
    case "consumed":
      return "status 'consumed' means the authorized operation was performed; report the 'result' field."
    case "denied":
    case "expired":
    case "revoked":
    case "superseded":
    case "failed":
      return (
        `status '${status}' means the operation will not happen under this authorization — explain it; do not re-request ` +
        "unless the user explicitly asks again."
      )
    default:
      return "status is unknown; do not claim the operation happened."
  }
}

/** The gateway view plus the reminder; a non-object answer is wrapped, never dropped. */
function withAuthorizationReminder(output: unknown): Record<string, unknown> {
  if (isRecord(output)) return { ...output, reminder: authorizationReminder(output["status"]) }
  return { view: output, reminder: authorizationReminder(undefined) }
}

export const WORKFLOW_AUTHORIZATION_TOOLS: readonly WorkflowToolDescriptor[] = [
  {
    id: "workflow_request_authorization",
    description:
      "REQUEST a human authorization for a protected operation — nothing is performed by this call. subject_kind and its " +
      "subject_ref: workflow.publish {agent_id, label?, notes?, force?}; workflow.restore {agent_id, version_number}; " +
      "workflow.set_live {agent_id, version_number}; schedule.update {schedule_id, changes:{enabled?, cron?, timezone?, " +
      "name?}}; schedule.delete {schedule_id}; batch.cancel {batch_id}. The server computes the binding and risk. Returns " +
      "202 with the authorization view: status 'requested' means a human must grant it in the Authorizations panel — the " +
      "operation has NOT happened. idempotency_key must be fresh per intended operation (a repeat replays). Error codes: " +
      "AUTHORIZATION_SUBJECT_NOOP (nothing to do) and AUTHORIZATION_IDEMPOTENCY_CONFLICT (an equivalent request exists) " +
      "mean do NOT re-request — explain them.",
    parameters: {
      type: "object",
      properties: {
        subject_kind: { type: "string", enum: [...AUTHORIZATION_SUBJECT_KINDS] },
        subject_ref: {
          type: "object",
          description:
            "The reference for the subject kind (see the tool description); for workflow.* subjects agent_id is the turn's workflow.",
        },
        idempotency_key: { type: "string", description: "Fresh per intended operation; a repeat replays the same authorization." },
        rationale: { type: "string", description: "One sentence quoting what the user asked for." },
      },
      required: ["subject_kind", "subject_ref", "idempotency_key"],
      additionalProperties: false,
    },
    execute: async (client, args) =>
      withAuthorizationReminder(
        await client.requestAuthorization({
          subject_kind: String(args["subject_kind"]) as AuthorizationSubjectKind,
          subject_ref: isRecord(args["subject_ref"]) ? args["subject_ref"] : {},
          idempotency_key: String(args["idempotency_key"]),
          ...(optionalString(args["rationale"]) ? { rationale: String(args["rationale"]) } : {}),
          // Engine-set by the responder at dispatch; the model's schema has no turn_id.
          ...(optionalString(args["turn_id"]) ? { turn_id: String(args["turn_id"]) } : {}),
        }),
      ),
  },
  {
    id: "workflow_authorization_get",
    description:
      "Read back one authorization request's view and status (requested|granted|consumed|denied|expired|revoked|" +
      "superseded|failed). Only 'consumed' means the operation was performed. One gateway token per call — poll at most once.",
    parameters: {
      type: "object",
      properties: { authorization_id: { type: "string", description: "The authorization id from the request result." } },
      required: ["authorization_id"],
      additionalProperties: false,
    },
    execute: async (client, args) => withAuthorizationReminder(await client.getAuthorization(String(args["authorization_id"]))),
  },
]

const TOOL_IDS = new Set(WORKFLOW_READ_TOOLS.map((tool) => tool.id))
const PROPOSAL_TOOL_IDS = new Set([...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS].map((tool) => tool.id))
const RUN_TOOL_IDS = new Set([...WORKFLOW_READ_TOOLS, ...WORKFLOW_RUN_TOOLS].map((tool) => tool.id))
const AUTHORIZATION_TOOL_IDS = new Set([...WORKFLOW_READ_TOOLS, ...WORKFLOW_AUTHORIZATION_TOOLS].map((tool) => tool.id))

/** Control-plane feature grants that unlock tool lists beyond the reads. */
export type ToolFeature = "propose" | "run" | "authorize"

/** True for a tool that exists only under the 'authorize' grant. */
export function isAuthorizationToolId(toolId: string): boolean {
  return WORKFLOW_AUTHORIZATION_TOOLS.some((tool) => tool.id === toolId)
}

/** The exact tool list for a turn's feature grants: reads always, proposal
 * tools with 'propose', run tools with 'run', authorization tools with
 * 'authorize'. Unknown feature names unlock nothing. */
export function toolsForFeatures(features: readonly string[]): readonly WorkflowToolDescriptor[] {
  return [
    ...WORKFLOW_READ_TOOLS,
    ...(features.includes("propose") ? WORKFLOW_PROPOSAL_TOOLS : []),
    ...(features.includes("run") ? WORKFLOW_RUN_TOOLS : []),
    ...(features.includes("authorize") ? WORKFLOW_AUTHORIZATION_TOOLS : []),
  ]
}

/** Resolve within the tools the features unlock; anything else — including a
 * run tool named while only 'propose' is granted — throws ToolDeniedError. */
export function resolveFeatureTool(features: readonly string[], toolId: string): WorkflowToolDescriptor {
  const tool = toolsForFeatures(features).find((candidate) => candidate.id === toolId)
  if (!tool) throw new ToolDeniedError(toolId)
  return tool
}

/** Resolve within the PROPOSAL surface (read + propose); everything else —
 * approve, apply, bash, anything — throws exactly like the read surface. */
export function resolveProposalTool(toolId: string): WorkflowToolDescriptor {
  const tool = [...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS].find((candidate) => candidate.id === toolId)
  if (!tool || !PROPOSAL_TOOL_IDS.has(toolId)) throw new ToolDeniedError(toolId)
  return tool
}

/** Resolve within the RUN surface (read + run); proposal tools, publish,
 * restore, schedule, bash, anything else throws ToolDeniedError. */
export function resolveRunTool(toolId: string): WorkflowToolDescriptor {
  const tool = [...WORKFLOW_READ_TOOLS, ...WORKFLOW_RUN_TOOLS].find((candidate) => candidate.id === toolId)
  if (!tool || !RUN_TOOL_IDS.has(toolId)) throw new ToolDeniedError(toolId)
  return tool
}

/** Resolve within the AUTHORIZATION surface (read + request/get); grant,
 * approve, revoke, run, proposal, bash, anything else throws ToolDeniedError. */
export function resolveAuthorizationTool(toolId: string): WorkflowToolDescriptor {
  const tool = [...WORKFLOW_READ_TOOLS, ...WORKFLOW_AUTHORIZATION_TOOLS].find((candidate) => candidate.id === toolId)
  if (!tool || !AUTHORIZATION_TOOL_IDS.has(toolId)) throw new ToolDeniedError(toolId)
  return tool
}

/** Resolve a tool or throw ToolDeniedError — the ONLY lookup path, so an
 * injected request for "bash"/"edit"/"browser_execute" cannot reach anything. */
export function resolveTool(toolId: string): WorkflowToolDescriptor {
  const tool = WORKFLOW_READ_TOOLS.find((candidate) => candidate.id === toolId)
  if (!tool || !TOOL_IDS.has(toolId)) throw new ToolDeniedError(toolId)
  return tool
}

/** Guard used by tests and the serve integration: the surface is exactly the
 * read-only list — a build that accidentally registers more must fail. */
export function assertReadOnlySurface(registeredToolIds: readonly string[]): void {
  const extras = registeredToolIds.filter((id) => !TOOL_IDS.has(id))
  if (extras.length > 0) {
    throw new ToolDeniedError(extras.join(", "))
  }
}
