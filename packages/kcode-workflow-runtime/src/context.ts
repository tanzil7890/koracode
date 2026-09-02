/**
 * The typed, scoped data store carried between node executions.
 *
 * Mirrors the reference runtime's `ExecutionContext`. Publication is
 * write-once, keyed by a structured instance key rather than a bare node id, so
 * the same node reached at a different definition path, loop iteration, or
 * visit is a distinct publication.
 */
import type { DataSource, JsonValue } from "@koracode/kcode-workflow-contracts"
import { DataResolutionError } from "./errors"
import { compareCodePoints, isJsonObject } from "./json"

export type InstanceKey = {
  readonly definitionPath: readonly string[]
  readonly nodeId: string
  readonly iterationPath: readonly number[]
  readonly visit: number
}

export type EdgeKey = {
  readonly definitionPath: readonly string[]
  readonly edgeId: string
  readonly iterationPath: readonly number[]
  readonly visit: number
}

export function instanceKey(
  definitionPath: readonly string[],
  nodeId: string,
  iterationPath: readonly number[] = [],
  visit = 1,
): InstanceKey {
  return { definitionPath, nodeId, iterationPath, visit }
}

export function edgeKey(
  definitionPath: readonly string[],
  edgeId: string,
  iterationPath: readonly number[] = [],
  visit = 1,
): EdgeKey {
  return { definitionPath, edgeId, iterationPath, visit }
}

/** `definitions/<path>/nodes/<id>/iterations/<iters>/visits/<n>` — never a value. */
export function instanceLocation(key: InstanceKey): string {
  const path = key.definitionPath.join("/") || "root"
  const iterations = key.iterationPath.join(".") || "root"
  return `definitions/${path}/nodes/${key.nodeId}/iterations/${iterations}/visits/${key.visit}`
}

export function edgeLocation(key: EdgeKey): string {
  const path = key.definitionPath.join("/") || "root"
  const iterations = key.iterationPath.join(".") || "root"
  return `definitions/${path}/edges/${key.edgeId}/iterations/${iterations}/visits/${key.visit}`
}

function sameSegments(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameIterations(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Python tuple ordering: element-wise, then shorter-is-smaller. */
function compareSegments(left: readonly string[], right: readonly string[]): number {
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) {
    const order = compareCodePoints(left[index] ?? "", right[index] ?? "")
    if (order !== 0) return order
  }
  return left.length - right.length
}

function compareIterations(left: readonly number[], right: readonly number[]): number {
  const shared = Math.min(left.length, right.length)
  for (let index = 0; index < shared; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return left.length - right.length
}

/** The frozen key's declared field order is its sort order. */
function compareInstanceKeys(left: InstanceKey, right: InstanceKey): number {
  const path = compareSegments(left.definitionPath, right.definitionPath)
  if (path !== 0) return path
  const node = compareCodePoints(left.nodeId, right.nodeId)
  if (node !== 0) return node
  const iterations = compareIterations(left.iterationPath, right.iterationPath)
  if (iterations !== 0) return iterations
  return left.visit - right.visit
}

function compareEdgeKeys(left: EdgeKey, right: EdgeKey): number {
  const path = compareSegments(left.definitionPath, right.definitionPath)
  if (path !== 0) return path
  const edge = compareCodePoints(left.edgeId, right.edgeId)
  if (edge !== 0) return edge
  const iterations = compareIterations(left.iterationPath, right.iterationPath)
  if (iterations !== 0) return iterations
  return left.visit - right.visit
}

type Publication<Key> = { readonly key: Key; readonly value: JsonValue }

/**
 * Run inputs plus immutable publications from node and edge executions.
 *
 * A subworkflow child receives a fresh `runInput` but shares the publication
 * stores by reference, exactly as the reference runtime does, so a child's
 * outputs stay addressable from the parent by definition path.
 */
export class ExecutionContext {
  readonly runInput: Readonly<Record<string, JsonValue>>
  readonly #nodeOutputs: Publication<InstanceKey>[]
  readonly #edgePayloads: Publication<EdgeKey>[]
  readonly #previousByScope: Map<string, JsonValue>

  private constructor(
    runInput: Readonly<Record<string, JsonValue>>,
    nodeOutputs: Publication<InstanceKey>[],
    edgePayloads: Publication<EdgeKey>[],
    previousByScope: Map<string, JsonValue>,
  ) {
    this.runInput = runInput
    this.#nodeOutputs = nodeOutputs
    this.#edgePayloads = edgePayloads
    this.#previousByScope = previousByScope
  }

  static create(runInput: Readonly<Record<string, JsonValue>>): ExecutionContext {
    return new ExecutionContext(runInput, [], [], new Map())
  }

  /** A child scope: new run input, shared publication stores. */
  child(runInput: Readonly<Record<string, JsonValue>>): ExecutionContext {
    return new ExecutionContext(runInput, this.#nodeOutputs, this.#edgePayloads, this.#previousByScope)
  }

  publishNode(key: InstanceKey, value: JsonValue): void {
    if (this.#nodeOutputs.some((entry) => compareInstanceKeys(entry.key, key) === 0)) {
      throw new DataResolutionError("DUPLICATE_NODE_PUBLICATION", instanceLocation(key))
    }
    this.#nodeOutputs.push({ key, value })
    this.#previousByScope.set(scopeKey(key.definitionPath, key.iterationPath), value)
  }

  publishEdge(key: EdgeKey, value: JsonValue): void {
    if (this.#edgePayloads.some((entry) => compareEdgeKeys(entry.key, key) === 0)) {
      throw new DataResolutionError("DUPLICATE_EDGE_PUBLICATION", edgeLocation(key))
    }
    this.#edgePayloads.push({ key, value })
  }

  resolve(source: DataSource, current: InstanceKey): JsonValue {
    const location = `${instanceLocation(current)}/source`
    let value: JsonValue
    if (source.from === "run") {
      value = this.runInput
    } else if (source.from === "previous") {
      const scope = scopeKey(current.definitionPath, current.iterationPath)
      if (!this.#previousByScope.has(scope)) throw new DataResolutionError("SOURCE_NOT_FOUND", location)
      value = this.#previousByScope.get(scope) ?? null
    } else if (source.from === "node") {
      const path = source.definition_path?.length ? source.definition_path : current.definitionPath
      const matches = this.#nodeOutputs.filter(
        (entry) => sameSegments(entry.key.definitionPath, path) && entry.key.nodeId === source.node_id,
      )
      value = select(matches, (entry) => entry.key, compareInstanceKeys, source.selection, current, location)
    } else {
      const path = source.definition_path?.length ? source.definition_path : current.definitionPath
      const matches = this.#edgePayloads.filter(
        (entry) => sameSegments(entry.key.definitionPath, path) && entry.key.edgeId === source.edge_id,
      )
      value = select(matches, (entry) => entry.key, compareEdgeKeys, source.selection, current, location)
    }
    return resolveJsonPointer(value, source.pointer ?? "", location)
  }
}

function scopeKey(definitionPath: readonly string[], iterationPath: readonly number[]): string {
  return `${JSON.stringify(definitionPath)}|${JSON.stringify(iterationPath)}`
}

function select<
  Entry extends { readonly value: JsonValue },
  Key extends { readonly iterationPath: readonly number[]; readonly visit: number },
>(
  matches: readonly Entry[],
  keyOf: (entry: Entry) => Key,
  compare: (left: Key, right: Key) => number,
  selection: DataSource["selection"],
  current: InstanceKey,
  location: string,
): JsonValue {
  if (selection === "all_in_scope") {
    return matches.toSorted((left, right) => compare(keyOf(left), keyOf(right))).map((entry) => entry.value)
  }
  if (selection === "latest_same_iteration") {
    const scoped = matches.filter((entry) => sameIterations(keyOf(entry).iterationPath, current.iterationPath))
    if (scoped.length === 0) throw new DataResolutionError("SOURCE_NOT_FOUND", location)
    // Python's `max` keeps the FIRST maximum in iteration order.
    return scoped.reduce((best, entry) => (keyOf(entry).visit > keyOf(best).visit ? entry : best)).value
  }
  if (matches.length !== 1) {
    throw new DataResolutionError(matches.length === 0 ? "SOURCE_NOT_FOUND" : "SOURCE_AMBIGUOUS", location)
  }
  return matches[0]?.value ?? null
}

/** Strict RFC 6901: no coercion, no value in the error. */
export function resolveJsonPointer(value: JsonValue, pointer: string, location: string): JsonValue {
  if (pointer === "") return value
  if (!pointer.startsWith("/")) throw new DataResolutionError("INVALID_JSON_POINTER", location)
  let current: JsonValue = value
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~")
    if (isJsonObject(current)) {
      if (!Object.hasOwn(current, token)) throw new DataResolutionError("POINTER_NOT_FOUND", location)
      current = current[token] ?? null
      continue
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(token)) throw new DataResolutionError("POINTER_NOT_FOUND", location)
      const index = Number(token)
      if (index >= current.length) throw new DataResolutionError("POINTER_NOT_FOUND", location)
      current = current[index] ?? null
      continue
    }
    throw new DataResolutionError("POINTER_NOT_FOUND", location)
  }
  return current
}
