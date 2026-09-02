// The exact read-only workflow tool surface — Phase 12.4 steps 6/7/13.
//
// Six tools, all GETs through WorkflowControlPlaneClient. Anything not in
// this list does not exist for the managed profile: there is no bash, no
// write/edit/patch, no generic fetch/search, no MCP passthrough, no raw
// browser_execute, no cookie/storage access, and no host process surface.

import type { WorkflowControlPlaneClient } from "./client"

export interface WorkflowToolDescriptor {
  readonly id: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly execute: (client: WorkflowControlPlaneClient, args: Record<string, unknown>) => Promise<unknown>
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

const TOOL_IDS = new Set(WORKFLOW_READ_TOOLS.map((tool) => tool.id))
const PROPOSAL_TOOL_IDS = new Set([...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS].map((tool) => tool.id))

/** Resolve within the PROPOSAL surface (read + propose); everything else —
 * approve, apply, bash, anything — throws exactly like the read surface. */
export function resolveProposalTool(toolId: string): WorkflowToolDescriptor {
  const tool = [...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS].find((candidate) => candidate.id === toolId)
  if (!tool || !PROPOSAL_TOOL_IDS.has(toolId)) throw new ToolDeniedError(toolId)
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
