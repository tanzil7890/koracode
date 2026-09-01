import type { RunEventV1 } from "../contract/generated/workflow-protocol"

export class EventOrderViolation extends Error {
  constructor(
    readonly code: string,
    readonly index: number,
  ) {
    super(`${code} at event index ${index}`)
  }
}

export function validateEventOrder(events: readonly RunEventV1[]) {
  if (events.length === 0 || events[0]?.kind !== "run_started") throw new EventOrderViolation("RUN_START_REQUIRED", 0)
  const open = new Set<string>()
  const state = events.reduce(
    (current, event, index) => {
      if (event.sequence <= current.sequence) throw new EventOrderViolation("SEQUENCE_NOT_MONOTONIC", index)
      if (current.finished) throw new EventOrderViolation("EVENT_AFTER_RUN_FINISH", index)
      if (event.kind === "node_started") {
        if (!event.node_key || open.has(event.node_key)) throw new EventOrderViolation("NODE_START_INVALID", index)
        open.add(event.node_key)
      }
      if (event.kind === "node_finished") {
        if (!open.has(event.node_key)) throw new EventOrderViolation("NODE_FINISH_WITHOUT_START", index)
        open.delete(event.node_key)
      }
      if (event.kind === "run_finished") {
        if (open.size > 0) throw new EventOrderViolation("RUN_FINISH_WITH_OPEN_NODE", index)
        return { sequence: event.sequence, finished: true }
      }
      return { sequence: event.sequence, finished: false }
    },
    { sequence: 0, finished: false },
  )
  if (!state.finished) throw new EventOrderViolation("RUN_FINISH_REQUIRED", events.length)
}
