/**
 * The injected action boundary.
 *
 * Everything the kernel cannot decide on its own — what a page said, what a
 * model chose, whether a step succeeded — arrives as an outcome supplied by the
 * host. The kernel owns the decision that follows; it never performs the act.
 * This is the seam a later phase replaces with a real browser and model without
 * touching a line of graph semantics.
 */
import type { GraphEdge, JsonValue } from "@koracode/kcode-workflow-contracts"
import { TerminationReason, validateTerminalPair } from "./terminal"
import type { LifecycleStatus } from "./terminal"

export type CheckKind = "url_contains" | "text_present" | "element_exists" | "ai_judge"

export type ActionSite = {
  readonly nodeKey: string
  readonly nodeId: string
  readonly definitionPath: readonly string[]
  readonly visit: number
}

/** A deterministic page-state check for a condition node. */
export type ConditionRequest = ActionSite & {
  readonly kind: "condition"
  readonly check: { readonly kind: CheckKind; readonly value: string }
}

/** The post-task `expected_outcome` check on an agent node. */
export type VerificationRequest = ActionSite & {
  readonly kind: "verification"
  readonly check: { readonly kind: CheckKind; readonly value: string }
}

/** One scoped agent task on a classic agent node. */
export type AgentRequest = ActionSite & {
  readonly kind: "agent"
  readonly instruction: string
  readonly narrowedInputs: Readonly<Record<string, JsonValue>> | null
  readonly model: string | null
  readonly capabilities: readonly string[] | null
  readonly globalRules: string | null
}

/** One scoped agent task per loop item. */
export type LoopItemRequest = ActionSite & {
  readonly kind: "loop_item"
  readonly instruction: string
  readonly index: number
  readonly total: number
  readonly item: JsonValue
  readonly globalRules: string | null
}

/** A transition-mode node: the host chooses one of the declared edges. */
export type TransitionRequest = ActionSite & {
  readonly kind: "transition"
  readonly instruction: string
  readonly narrowedInputs: Readonly<Record<string, JsonValue>> | null
  readonly model: string | null
  readonly edges: readonly GraphEdge[]
  readonly globalRules: string | null
}

/**
 * Replay of a node's captured deterministic steps.
 *
 * The kernel owns the decision to attempt one — the captured hash still matches
 * the instruction — and owns what follows from the verdict. Performing the
 * steps belongs to the browser substrate, so the verdict is injected.
 */
export type ReplayRequest = ActionSite & {
  readonly kind: "replay"
  readonly steps: readonly JsonValue[]
  readonly instructionHash: string
  /** True on a transition-mode node, where a replay is context, never a route. */
  readonly transition: boolean
}

export type ReplayStep = {
  readonly n: number
  readonly action: string
  readonly ok: boolean
  readonly detail: string | null
}

export type ReplayOutcome = {
  readonly ok: boolean
  readonly detail: string
  /** Per-step records, replayed into the event stream in order. */
  readonly steps?: readonly ReplayStep[]
}

export type ActionRequest =
  | ConditionRequest
  | VerificationRequest
  | AgentRequest
  | LoopItemRequest
  | TransitionRequest
  | ReplayRequest

export type CheckOutcome = { readonly passed: boolean; readonly detail: string }

export type TaskOutcome = {
  readonly status: LifecycleStatus
  readonly output?: JsonValue
  readonly error?: string | null
  readonly terminationReason?: TerminationReason
  /** The raw agent verdict; `null` means it never finished, `undefined` means none was produced. */
  readonly isSuccessful?: boolean | null
  readonly mode?: "agent" | "deterministic"
  readonly tokens?: number | null
}

export type EdgeChoice = {
  readonly edgeId: string
  readonly to: string
  readonly via: "handoff" | "selector_latch" | "timeout" | "stop_reprompt" | "failure_path"
  readonly summary?: string
  readonly payload?: JsonValue
}

export type TransitionOutcome = TaskOutcome & { readonly edge?: EdgeChoice | null }

export type ActionOutcome = CheckOutcome | TaskOutcome | TransitionOutcome | ReplayOutcome

/**
 * Normalize a host-supplied task outcome the way the reference contract does,
 * so an inconsistent pair is rejected at the seam rather than becoming an
 * impossible terminal later.
 */
export function normalizeTaskOutcome(outcome: TaskOutcome): Required<Pick<TaskOutcome, "status">> & {
  readonly terminationReason: TerminationReason
  readonly output: JsonValue
  readonly error: string | null
  readonly isSuccessful: boolean | null | undefined
  readonly mode: "agent" | "deterministic" | undefined
  readonly tokens: number | null
} {
  let reason = outcome.terminationReason ?? TerminationReason.Done
  if (outcome.status === "failed" && reason === TerminationReason.Done) reason = TerminationReason.ReportedFailure
  else if (outcome.status === "cancelled") reason = TerminationReason.Cancelled
  validateTerminalPair(outcome.status, reason)
  return {
    status: outcome.status,
    terminationReason: reason,
    output: outcome.output ?? null,
    error: outcome.error ?? null,
    isSuccessful: outcome.isSuccessful,
    mode: outcome.mode,
    tokens: outcome.tokens ?? null,
  }
}

/**
 * A host driving the kernel. Every method is synchronous and total: an
 * asynchronous host drives the generator directly instead of implementing this.
 */
export type ActionPort = {
  readonly condition: (request: ConditionRequest) => CheckOutcome
  readonly verification: (request: VerificationRequest) => CheckOutcome
  readonly agent: (request: AgentRequest) => TaskOutcome
  readonly loopItem: (request: LoopItemRequest) => TaskOutcome
  readonly transition: (request: TransitionRequest) => TransitionOutcome
  readonly replay: (request: ReplayRequest) => ReplayOutcome
}

/** A host answer that does not match the question is a refusal, not a guess. */
export class ActionContractError extends Error {
  override readonly name = "ActionContractError"
  readonly code = "ACTION_OUTCOME_INVALID"
}

export function asCheckOutcome(outcome: ActionOutcome): CheckOutcome {
  if (!("passed" in outcome)) throw new ActionContractError("a check must answer with passed/detail")
  return outcome
}

export function asReplayOutcome(outcome: ActionOutcome): ReplayOutcome {
  if (!("ok" in outcome)) throw new ActionContractError("a replay must answer with ok/detail")
  return outcome
}

export function asTaskOutcome(outcome: ActionOutcome): TransitionOutcome {
  if (!("status" in outcome)) throw new ActionContractError("a task must answer with a lifecycle status")
  return outcome
}

export function answer(port: ActionPort, request: ActionRequest): ActionOutcome {
  if (request.kind === "condition") return port.condition(request)
  if (request.kind === "verification") return port.verification(request)
  if (request.kind === "agent") return port.agent(request)
  if (request.kind === "loop_item") return port.loopItem(request)
  if (request.kind === "transition") return port.transition(request)
  return port.replay(request)
}
