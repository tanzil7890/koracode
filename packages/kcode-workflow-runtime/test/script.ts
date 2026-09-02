/**
 * The scripted action boundary, TypeScript side.
 *
 * This is the exact counterpart of
 * `workflows/tests/koracode/runtime_vectors/script.py`: five default formulas
 * plus per-`kind:node_key` override queues consumed in order. If the two ever
 * disagree the differential test fails, which is the point — the script is the
 * only thing both engines are told, so it has to mean the same thing to both.
 */
import type { JsonValue } from "@koracode/kcode-workflow-contracts"
import { TerminationReason, asString, isJsonObject, isTerminationReason, oneOf } from "../src"
import type {
  ActionPort,
  ActionRequest,
  AgentRequest,
  CheckOutcome,
  ConditionRequest,
  EdgeChoice,
  LoopItemRequest,
  ReplayOutcome,
  ReplayRequest,
  TaskOutcome,
  TransitionOutcome,
  TransitionRequest,
  VerificationRequest,
} from "../src"

export type ScriptDoc = {
  readonly version: number
  readonly queues: Readonly<Record<string, readonly Readonly<Record<string, JsonValue>>[]>>
}

export type Recorded = { readonly node_key: string; readonly instruction: string }

const edgeVias: readonly EdgeChoice["via"][] = ["handoff", "selector_latch", "timeout", "stop_reprompt", "failure_path"]
const lifecycles: readonly TaskOutcome["status"][] = ["completed", "failed", "cancelled"]

export function defaultAgent(nodeID: string): Readonly<Record<string, JsonValue>> {
  return { status: "completed", output: `${nodeID} output`, is_successful: true }
}

export function defaultLoopItem(index: number): Readonly<Record<string, JsonValue>> {
  return { status: "completed", output: `item ${index}`, is_successful: true }
}

export function defaultCondition(): Readonly<Record<string, JsonValue>> {
  return { passed: true, detail: "ok" }
}

export function defaultVerification(): Readonly<Record<string, JsonValue>> {
  return { passed: true, detail: "" }
}

export function defaultReplay(steps: readonly JsonValue[]): Readonly<Record<string, JsonValue>> {
  return {
    ok: true,
    detail: `${steps.length} step(s) replayed`,
    steps: steps.map((step, index) => ({
      n: index + 1,
      action: isJsonObject(step) ? asString(step["action"]) : "",
      ok: true,
      detail: null,
    })),
  }
}

export function defaultTransition(edges: TransitionRequest["edges"]): Readonly<Record<string, JsonValue>> {
  const edge = edges[0]
  if (edge === undefined) return { status: "failed", error: "no edge", edge: null }
  return {
    status: "completed",
    output: "",
    edge: { edge_id: edge.id, to: edge.to, via: "handoff", summary: "", payload: null },
  }
}

/** A port that answers from the script, and records what it was asked. */
export class ScriptedPort implements ActionPort {
  readonly instructions: Recorded[] = []
  readonly #queues: Readonly<Record<string, readonly Readonly<Record<string, JsonValue>>[]>>
  readonly #cursor = new Map<string, number>()

  constructor(script: ScriptDoc) {
    this.#queues = script.queues
  }

  #take(kind: string, nodeKey: string): Readonly<Record<string, JsonValue>> | null {
    const key = `${kind}:${nodeKey}`
    const queue = this.#queues[key]
    if (queue === undefined || queue.length === 0) return null
    const index = this.#cursor.get(key) ?? 0
    if (index >= queue.length) return null
    this.#cursor.set(key, index + 1)
    return queue[index] ?? null
  }

  #scripted(
    request: ActionRequest,
    fallback: Readonly<Record<string, JsonValue>>,
  ): Readonly<Record<string, JsonValue>> {
    return this.#take(request.kind, request.nodeKey) ?? fallback
  }

  condition(request: ConditionRequest): CheckOutcome {
    return check(this.#scripted(request, defaultCondition()))
  }

  verification(request: VerificationRequest): CheckOutcome {
    return check(this.#scripted(request, defaultVerification()))
  }

  agent(request: AgentRequest): TaskOutcome {
    this.instructions.push({ node_key: request.nodeKey, instruction: request.instruction })
    return task(this.#scripted(request, defaultAgent(request.nodeId)))
  }

  loopItem(request: LoopItemRequest): TaskOutcome {
    this.instructions.push({ node_key: request.nodeKey, instruction: request.instruction })
    return task(this.#scripted(request, defaultLoopItem(request.index)))
  }

  transition(request: TransitionRequest): TransitionOutcome {
    this.instructions.push({ node_key: request.nodeKey, instruction: request.instruction })
    const answer = this.#scripted(request, defaultTransition(request.edges))
    const edge = answer["edge"]
    return {
      ...task(answer),
      edge: isJsonObject(edge)
        ? {
            edgeId: asString(edge["edge_id"]),
            to: asString(edge["to"]),
            via: oneOf(edgeVias, edge["via"]) ? edge["via"] : "handoff",
            summary: asString(edge["summary"]),
            payload: edge["payload"] ?? null,
          }
        : null,
    }
  }

  replay(request: ReplayRequest): ReplayOutcome {
    const answer = this.#scripted(request, defaultReplay(request.steps))
    const steps = answer["steps"]
    return {
      ok: Boolean(answer["ok"]),
      detail: asString(answer["detail"]),
      steps: (Array.isArray(steps) ? steps : []).flatMap((step) =>
        isJsonObject(step)
          ? [
              {
                n: Number(step["n"] ?? 0),
                action: asString(step["action"]),
                ok: Boolean(step["ok"]),
                detail: typeof step["detail"] === "string" ? step["detail"] : null,
              },
            ]
          : [],
      ),
    }
  }
}

function check(answer: Readonly<Record<string, JsonValue>>): CheckOutcome {
  return { passed: Boolean(answer["passed"]), detail: asString(answer["detail"]) }
}

/**
 * The reference `TaskResult` fills in a reason when a scenario leaves it out,
 * and its `output`/`error` default to None rather than being absent.
 */
function task(answer: Readonly<Record<string, JsonValue>>): TaskOutcome {
  const raw = answer["status"]
  if (!oneOf(lifecycles, raw)) throw new Error(`a scripted outcome named an unknown status: ${asString(raw)}`)
  const status: TaskOutcome["status"] = raw
  const declared = answer["termination_reason"]
  const reason: TerminationReason = isTerminationReason(declared)
    ? declared
    : status === "completed"
      ? TerminationReason.Done
      : status === "cancelled"
        ? TerminationReason.Cancelled
        : TerminationReason.ReportedFailure
  const output = answer["output"]
  const error = answer["error"]
  const verdict = answer["is_successful"]
  return {
    status,
    terminationReason: reason,
    output: output === undefined ? null : output,
    error: typeof error === "string" ? error : null,
    isSuccessful: typeof verdict === "boolean" ? verdict : null,
  }
}
