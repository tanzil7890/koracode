/**
 * Deterministic decision events.
 *
 * The kernel emits nothing on its own schedule: the sequence number is a pure
 * counter and every timestamp comes from an injected clock, so the same input
 * and the same injected outcomes produce the same event stream byte for byte.
 * The per-run cap and the string truncation mirror the reference trace writer,
 * because those are observable in the stream a control plane stores.
 */
import type { JsonValue, RunEventV1 } from "@koracode/kcode-workflow-contracts"
import { truncateStrings } from "./json"

export const MAX_TEXT_LEN = 500
export const MAX_EVENTS_PER_RUN = 5000

export type EventPayload = Readonly<Record<string, JsonValue>>

/** Injected time and identity: the only two impurities a run needs. */
export type Clock = {
  /** Monotonic milliseconds, for durations and deadlines. */
  readonly monotonicMs: () => number
  /** RFC 3339 wall-clock stamp for the event envelope, or null to omit it. */
  readonly timestamp: () => string | null
}

/** A frozen clock: every reading is the same, which is what a golden test wants. */
export function fixedClock(monotonicMs = 0, timestamp: string | null = null): Clock {
  return { monotonicMs: () => monotonicMs, timestamp: () => timestamp }
}

/** A clock that advances by a fixed step on every monotonic reading. */
export function steppingClock(stepMs: number, startMs = 0, timestamp: string | null = null): Clock {
  let now = startMs
  return {
    monotonicMs: () => {
      const value = now
      now += stepMs
      return value
    },
    timestamp: () => timestamp,
  }
}

export class DecisionEventLog {
  readonly #events: RunEventV1[] = []
  #sequence = 0
  #truncated = false

  constructor(
    readonly runID: string,
    readonly clock: Clock,
    readonly attemptID: string | null = null,
  ) {}

  get events(): readonly RunEventV1[] {
    return this.#events
  }

  emit(nodeKey: string, kind: string, payload: EventPayload = {}): void {
    if (this.#sequence >= MAX_EVENTS_PER_RUN) {
      if (this.#truncated) return
      this.#truncated = true
      this.#sequence += 1
      this.#push("", "events_truncated", { cap: MAX_EVENTS_PER_RUN })
      return
    }
    this.#sequence += 1
    this.#push(nodeKey, kind, payload)
  }

  #push(nodeKey: string, kind: string, payload: EventPayload): void {
    const created = this.clock.timestamp()
    this.#events.push({
      protocol_version: "v1",
      run_id: this.runID,
      attempt_id: this.attemptID,
      sequence: this.#sequence,
      kind,
      node_key: nodeKey,
      payload: Object.fromEntries(
        Object.entries(payload).map(([key, value]) => [key, truncateStrings(value, MAX_TEXT_LEN)]),
      ),
      created_at: created,
    })
  }
}

/**
 * The collision-free node key: a definition path joined with the node id, each
 * segment JSON-Pointer escaped so a `/` inside an id cannot forge a boundary.
 */
export function definitionNodeKey(path: readonly string[], nodeID: string): string {
  return [...path, nodeID].map((segment) => segment.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")
}
