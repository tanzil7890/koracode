/**
 * Re-exports the neutral contract's own event-order rule, so a kernel test
 * checks the stream against the shared authority rather than a local opinion.
 */
import { validateEventOrder } from "@koracode/kcode-workflow-contracts"
import type { RunEventV1 } from "@koracode/kcode-workflow-contracts"

export { TerminationReason } from "../src"

export function validateEventOrderOrThrow(events: readonly RunEventV1[]): void {
  validateEventOrder(events)
}
