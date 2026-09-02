/**
 * The complete terminal taxonomy, mirrored from the reference runtime's
 * `backend/termination.py` and `backend/contracts/results.py`.
 *
 * Lifecycle status and outcome label are deliberately separate axes: a run is
 * `failed` for many different reasons, and the label is what a machine reads.
 */
import type { OutcomeLabel } from "@koracode/kcode-workflow-contracts"

export const TerminationReason = {
  Done: "done",
  ReportedFailure: "reported_failure",
  MaxSteps: "max_steps",
  GraphStepLimit: "graph_step_limit",
  NoHandoff: "no_handoff",
  NodeTimeout: "node_timeout",
  RunTimeout: "run_timeout",
  NodeVisitLimit: "node_visit_limit",
  ContractViolation: "contract_violation",
  OutputSchemaValidationFailed: "output_schema_validation_failed",
  SecurityPolicy: "security_policy",
  DefinitionInvalid: "definition_invalid",
  Cancelled: "cancelled",
  Exception: "exception",
} as const

export type TerminationReason = (typeof TerminationReason)[keyof typeof TerminationReason]

export const terminationReasons: readonly TerminationReason[] = Object.values(TerminationReason)

export type LifecycleStatus = "completed" | "failed" | "cancelled"

export class TerminalContractError extends Error {
  readonly code = "TERMINAL_PAIR_INVALID"
}

export function isTerminationReason(value: unknown): value is TerminationReason {
  return typeof value === "string" && (terminationReasons as readonly string[]).includes(value)
}

export function asTerminationReason(value: unknown): TerminationReason {
  if (!isTerminationReason(value)) throw new TerminalContractError(`unknown termination reason ${String(value)}`)
  return value
}

/** `completed` implies `done`, `cancelled` implies `cancelled`, and `failed` implies neither. */
export function validateTerminalPair(status: string, reason: TerminationReason): TerminationReason {
  if (status !== "completed" && status !== "failed" && status !== "cancelled") {
    throw new TerminalContractError(`unknown terminal status ${status}`)
  }
  if (status === "completed" && reason !== TerminationReason.Done) {
    throw new TerminalContractError(`completed is incompatible with termination reason ${reason}`)
  }
  if (status === "cancelled" && reason !== TerminationReason.Cancelled) {
    throw new TerminalContractError("cancelled requires termination reason cancelled")
  }
  if (status === "failed" && (reason === TerminationReason.Done || reason === TerminationReason.Cancelled)) {
    throw new TerminalContractError(`failed is incompatible with termination reason ${reason}`)
  }
  return reason
}

const timedOut: readonly TerminationReason[] = [TerminationReason.NodeTimeout, TerminationReason.RunTimeout]
const executionLimit: readonly TerminationReason[] = [
  TerminationReason.MaxSteps,
  TerminationReason.GraphStepLimit,
  TerminationReason.NodeVisitLimit,
]
const contractViolation: readonly TerminationReason[] = [
  TerminationReason.ContractViolation,
  TerminationReason.OutputSchemaValidationFailed,
  TerminationReason.DefinitionInvalid,
]

export function outcomeLabelFor(status: string, reason: TerminationReason): OutcomeLabel {
  if (status === "completed") return "completed"
  if (status === "cancelled") return "cancelled"
  if (timedOut.includes(reason)) return "timed_out"
  if (executionLimit.includes(reason)) return "execution_limit"
  if (reason === TerminationReason.SecurityPolicy) return "policy_denied"
  if (contractViolation.includes(reason)) return "contract_violation"
  if (reason === TerminationReason.Exception) return "indeterminate"
  return "reported_failure"
}

/** The run-level reason: cancelled and completed are affirmative, everything else falls back. */
export function runTerminationReason(status: LifecycleStatus, latched: TerminationReason | null): TerminationReason {
  if (status === "cancelled") return TerminationReason.Cancelled
  if (status === "completed") return TerminationReason.Done
  return latched ?? TerminationReason.Exception
}
