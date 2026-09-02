// Engine-side candidate normalization — Phase 12.7 engine quality (v7).
//
// The control plane stays strict: it validates every proposal and rejects
// anything off-contract. This module lives on the UNTRUSTED engine side and
// makes the model's candidate satisfy the contract before it is ever sent:
//
//   * normalizeCandidate — deterministic repairs whose only valid fix is
//     mechanical (declare referenced variables, default node positions, add
//     x-source annotations, move a source-less scripts[] entry to the
//     singular script wiring, drop duplicate success/error edges, …). Every
//     repair is reported so the model (and the audit trail) can see it.
//   * lintCandidate — a local mirror of the validator's structural rules
//     (backend/graph/schema.py validate_graph + the pydantic shapes) so most
//     rejections are caught without spending a one-use gateway token.
//   * guidanceFor — precise, code-keyed repair instructions for anything the
//     engine must not guess (renamed ids, missing endpoints, cycles, …).
//   * applyPatchOps — an exact mirror of backend/workflow_proposals/patch.py
//     so patch proposals can be normalized and validated as full candidates.
//
// Nothing here touches canonical state; the gateway remains the authority.

export type JsonObject = Record<string, unknown>

export interface RepairNote {
  readonly code: string
  readonly detail: string
}

export interface LocalIssue {
  readonly code: string
  readonly message: string
  readonly node_id?: string
  readonly edge_id?: string
}

export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PatchError"
  }
}

export const GRAPH_VERSION = 3
export const CONTRACT_CAPABILITIES: readonly string[] = ["browser", "screen.snapshot", "screen.computer", "scripts"]
export const DETERMINISTIC_CHECK_KINDS: readonly string[] = ["url_contains", "text_present", "element_exists"]
export const TASK_NODE_TYPES: readonly string[] = ["agent", "loop", "subworkflow"]
export const KNOWN_NODE_TYPES: readonly string[] = ["agent", "success", "error", "condition", "loop", "subworkflow", "output"]
const EDGE_WHEN: readonly string[] = ["success", "error", "true", "false", "ai", "selector"]
const FAILURE_ACTIONS: readonly string[] = ["fallback_to_ai", "cancel_execution"]
const SOURCE_FROM: readonly string[] = ["run", "previous", "node", "edge"]
const SOURCE_KEYS: readonly string[] = ["from", "pointer", "definition_path", "node_id", "edge_id", "selection"]
const VARIABLE_PATTERN = /\{\{\.([A-Z0-9_]+)\}\}/g
const MAX_PATCH_OPS = 50
const FILE_PATCH_MARKERS = ["--- a/", "+++ b/", "@@", "diff --git"]
const ALLOWED_OPS = new Set(["add_node", "set_node", "remove_node", "add_edge", "remove_edge", "set_settings"])

const WHEN_SYNONYMS: Record<string, string> = {
  fail: "error",
  failed: "error",
  failure: "error",
  err: "error",
  on_error: "error",
  ok: "success",
  succeed: "success",
  succeeded: "success",
  done: "success",
  next: "success",
  pass: "success",
  default: "success",
  yes: "true",
  no: "false",
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isBuiltinVariable(name: string): boolean {
  return name === "PREV_OUTPUT" || name === "ITEM" || name === "ITEM_INDEX" || (name.startsWith("NODE_") && name.endsWith("_OUTPUT"))
}

function referencedVariables(text: unknown, found: Set<string>): void {
  if (typeof text !== "string") return
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const name = match[1]!
    if (!isBuiltinVariable(name)) found.add(name)
  }
}

function nodeList(graph: JsonObject): JsonObject[] {
  return Array.isArray(graph["nodes"]) ? (graph["nodes"] as unknown[]).filter(isObject) : []
}

function edgeList(graph: JsonObject): JsonObject[] {
  return Array.isArray(graph["edges"]) ? (graph["edges"] as unknown[]).filter(isObject) : []
}

// ------------------------------------------------------------ patch mirror

/** Exact mirror of apply_canonical_patch: bounded op list on a deep copy. */
export function applyPatchOps(base: JsonObject, operations: unknown): JsonObject {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new PatchError("patch must be a non-empty list of operations")
  }
  if (operations.length > MAX_PATCH_OPS) throw new PatchError(`patch exceeds ${MAX_PATCH_OPS} operations`)
  const candidate = clone(base)
  if (!Array.isArray(candidate["nodes"])) candidate["nodes"] = []
  if (!Array.isArray(candidate["edges"])) candidate["edges"] = []
  const nodes = candidate["nodes"] as unknown[]
  operations.forEach((operation, index) => {
    if (!isObject(operation)) throw new PatchError(`operation ${index} is not an object`)
    const op = operation["op"] === undefined || operation["op"] === null ? "" : String(operation["op"])
    const serialized = JSON.stringify(operation)
    if (FILE_PATCH_MARKERS.some((marker) => serialized.includes(marker))) {
      throw new PatchError("filesystem patches are not accepted")
    }
    if (!ALLOWED_OPS.has(op)) throw new PatchError(`operation ${index}: unknown op '${op}'`)
    const nodeIndex = (id: string) => nodes.findIndex((node) => isObject(node) && String(node["id"]) === id)
    if (op === "add_node" || op === "set_node") {
      const node = operation["node"]
      if (!isObject(node) || !node["id"]) throw new PatchError(`operation ${index}: ${op} requires a node object with an id`)
      const position = nodeIndex(String(node["id"]))
      if (op === "add_node") {
        if (position !== -1) throw new PatchError(`operation ${index}: node ${String(node["id"])} already exists`)
        nodes.push(clone(node))
      } else {
        if (position === -1) throw new PatchError(`operation ${index}: node ${String(node["id"])} does not exist`)
        nodes[position] = clone(node)
      }
    } else if (op === "remove_node") {
      const nodeId = String(operation["id"] ?? "")
      const position = nodeIndex(nodeId)
      if (position === -1) throw new PatchError(`operation ${index}: node ${nodeId} does not exist`)
      nodes.splice(position, 1)
      candidate["edges"] = (candidate["edges"] as unknown[]).filter(
        (edge) => !(isObject(edge) && (String(edge["from"]) === nodeId || String(edge["to"]) === nodeId)),
      )
    } else if (op === "add_edge") {
      const edge = operation["edge"]
      if (!isObject(edge) || !edge["id"]) throw new PatchError(`operation ${index}: add_edge requires an edge object with an id`)
      if ((candidate["edges"] as unknown[]).some((e) => isObject(e) && e["id"] === edge["id"])) {
        throw new PatchError(`operation ${index}: edge ${String(edge["id"])} already exists`)
      }
      ;(candidate["edges"] as unknown[]).push(clone(edge))
    } else if (op === "remove_edge") {
      const edgeId = String(operation["id"] ?? "")
      const before = (candidate["edges"] as unknown[]).length
      candidate["edges"] = (candidate["edges"] as unknown[]).filter((e) => !(isObject(e) && String(e["id"]) === edgeId))
      if ((candidate["edges"] as unknown[]).length === before) throw new PatchError(`operation ${index}: edge ${edgeId} does not exist`)
    } else if (op === "set_settings") {
      const settings = operation["settings"]
      if (!isObject(settings)) throw new PatchError(`operation ${index}: set_settings requires an object`)
      candidate["settings"] = clone(settings)
    }
  })
  return candidate
}

// -------------------------------------------------------------- normalize

export interface NormalizeContext {
  /** The head graph the candidate derives from (for name/entry fallbacks). */
  readonly head?: JsonObject
}

export interface NormalizedCandidate {
  readonly graph: JsonObject
  readonly repairs: readonly RepairNote[]
}

function basename(path: string): string {
  const parts = path.split("/")
  return parts[parts.length - 1] ?? path
}

function normalizeAgentNode(node: JsonObject, repairs: RepairNote[]): void {
  const id = String(node["id"])
  // Singular wiring vs plural sources: a scripts[] entry WITHOUT source can
  // never be valid — the only valid reading is the node's fast-path wiring.
  if (typeof node["script"] === "string") {
    node["script"] = { filepath: node["script"], failure_action: "fallback_to_ai" }
    repairs.push({ code: "SCRIPT_STRING_TO_REF", detail: `node ${id}: script given as a string became {filepath, failure_action}` })
  }
  if (Array.isArray(node["scripts"])) {
    const withSource: unknown[] = []
    for (const entry of node["scripts"] as unknown[]) {
      if (isObject(entry) && typeof entry["source"] === "string" && typeof entry["filename"] === "string") {
        withSource.push(entry)
        continue
      }
      if (isObject(entry) && !isObject(node["script"])) {
        const named = entry["filepath"] ?? entry["filename"] ?? entry["path"] ?? entry["file"]
        if (typeof named === "string" && named.trim()) {
          const filepath = named.includes("/") ? named : `./scripts/${basename(named)}`
          const action = FAILURE_ACTIONS.includes(String(entry["failure_action"])) ? String(entry["failure_action"]) : "fallback_to_ai"
          node["script"] = { filepath, failure_action: action }
          repairs.push({
            code: "SCRIPTS_ENTRY_TO_SCRIPT",
            detail: `node ${id}: source-less scripts[] entry '${named}' moved to the singular script wiring {filepath:'${filepath}', failure_action:'${action}'}`,
          })
          continue
        }
      }
      repairs.push({ code: "SCRIPTS_ENTRY_DROPPED", detail: `node ${id}: dropped an invalid scripts[] entry (needs filename AND source)` })
    }
    if (withSource.length) node["scripts"] = withSource
    else delete node["scripts"]
  }
  if (isObject(node["script"])) {
    const script = node["script"]
    if (typeof script["filepath"] !== "string" && typeof script["filename"] === "string") {
      script["filepath"] = `./scripts/${basename(String(script["filename"]))}`
      delete script["filename"]
      repairs.push({ code: "SCRIPT_FILENAME_TO_FILEPATH", detail: `node ${id}: script.filename became script.filepath` })
    }
    if (!FAILURE_ACTIONS.includes(String(script["failure_action"]))) {
      script["failure_action"] = "fallback_to_ai"
      repairs.push({ code: "SCRIPT_FAILURE_ACTION_DEFAULTED", detail: `node ${id}: script.failure_action defaulted to fallback_to_ai` })
    }
  }
  if (Array.isArray(node["capabilities"])) {
    const kept = (node["capabilities"] as unknown[]).filter((c) => CONTRACT_CAPABILITIES.includes(String(c)))
    const dropped = (node["capabilities"] as unknown[]).filter((c) => !CONTRACT_CAPABILITIES.includes(String(c)))
    if (dropped.length) {
      repairs.push({
        code: "UNKNOWN_CAPABILITY_DROPPED",
        detail: `node ${id}: removed capabilities not in the reviewed catalog: ${dropped.map(String).join(", ")}`,
      })
      if (kept.length) node["capabilities"] = kept
      else delete node["capabilities"]
    }
  }
  if (isObject(node["input_schema"])) {
    const schema = node["input_schema"]
    if (schema["type"] === undefined) {
      schema["type"] = "object"
      repairs.push({ code: "SCHEMA_ROOT_TYPE_DEFAULTED", detail: `node ${id}: input_schema.type defaulted to 'object'` })
    }
    if (isObject(schema["properties"])) {
      for (const [name, property] of Object.entries(schema["properties"])) {
        if (!isObject(property)) continue
        const source = property["x-source"]
        const valid =
          isObject(source) &&
          SOURCE_FROM.includes(String(source["from"])) &&
          (source["pointer"] === undefined || typeof source["pointer"] === "string") &&
          Object.keys(source).every((key) => SOURCE_KEYS.includes(key))
        if (!valid) {
          if (isObject(source) && SOURCE_FROM.includes(String(source["from"]))) {
            for (const key of Object.keys(source)) if (!SOURCE_KEYS.includes(key)) delete source[key]
            if (source["pointer"] !== undefined && typeof source["pointer"] !== "string") source["pointer"] = `/${name}`
            repairs.push({ code: "SCHEMA_SOURCE_TRIMMED", detail: `node ${id}: input_schema property '${name}' x-source reduced to its contract keys` })
          } else {
            property["x-source"] = { from: "run", pointer: `/${name}` }
            repairs.push({
              code: "SCHEMA_SOURCE_ADDED",
              detail: `node ${id}: input_schema property '${name}' got x-source {from:'run', pointer:'/${name}'}`,
            })
          }
        }
      }
    }
  }
}

function normalizeConditionNode(node: JsonObject, repairs: RepairNote[]): void {
  const id = String(node["id"])
  if (!isObject(node["check"]) && (node["kind"] !== undefined || node["value"] !== undefined)) {
    node["check"] = { kind: node["kind"], value: node["value"] }
    delete node["kind"]
    delete node["value"]
    repairs.push({ code: "CONDITION_CHECK_WRAPPED", detail: `node ${id}: top-level kind/value wrapped into check:{kind,value}` })
  }
  if (isObject(node["check"])) {
    const check = node["check"]
    if (check["kind"] === undefined && typeof check["type"] === "string") {
      check["kind"] = check["type"]
      delete check["type"]
      repairs.push({ code: "CONDITION_CHECK_KIND_RENAMED", detail: `node ${id}: check.type became check.kind` })
    }
    if (check["value"] === undefined) {
      for (const alias of ["text", "expected", "contains", "url", "selector"]) {
        if (typeof check[alias] === "string") {
          check["value"] = check[alias]
          delete check[alias]
          repairs.push({ code: "CONDITION_CHECK_VALUE_RENAMED", detail: `node ${id}: check.${alias} became check.value` })
          break
        }
      }
    }
  }
}

function normalizeLoopNode(node: JsonObject, repairs: RepairNote[]): void {
  const id = String(node["id"])
  const raw = node["max_iterations"]
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    node["max_iterations"] = Number.isFinite(parsed) && parsed > 50 ? 50 : 10
    repairs.push({ code: "LOOP_BOUND_DEFAULTED", detail: `node ${id}: max_iterations set to ${String(node["max_iterations"])} (contract: integer 1..50)` })
  } else if (typeof raw !== "number") {
    node["max_iterations"] = parsed
  }
}

function normalizeSubworkflowNode(node: JsonObject, repairs: RepairNote[]): void {
  const id = String(node["id"])
  const mapping = node["input_mapping"]
  if (mapping === undefined || mapping === null) return
  if (!isObject(mapping)) {
    node["input_mapping"] = {}
    repairs.push({ code: "INPUT_MAPPING_RESET", detail: `node ${id}: input_mapping was not an object and became {}` })
    return
  }
  for (const [key, value] of Object.entries(mapping)) {
    if (typeof value !== "string") {
      mapping[key] = isObject(value) || Array.isArray(value) ? JSON.stringify(value) : String(value)
      repairs.push({ code: "INPUT_MAPPING_STRINGIFIED", detail: `node ${id}: input_mapping.${key} became a string (contract: string literal or {{.VAR}} template)` })
    }
  }
}

/** Deterministic repairs whose only valid fix is mechanical. Never invents
 * ids, targets, instructions, or routing — those go to lint + guidance. */
export function normalizeCandidate(raw: unknown, context: NormalizeContext = {}): NormalizedCandidate {
  const repairs: RepairNote[] = []
  if (!isObject(raw)) return { graph: isObject(raw) ? raw : {}, repairs }
  const graph = clone(raw)
  const head = context.head

  if (typeof graph["version"] !== "number" || graph["version"] < GRAPH_VERSION) graph["version"] = GRAPH_VERSION
  if (typeof graph["name"] !== "string" || !graph["name"].trim()) {
    graph["name"] = typeof head?.["name"] === "string" ? head["name"] : "Workflow"
    repairs.push({ code: "NAME_DEFAULTED", detail: `top-level name set to '${String(graph["name"])}'` })
  }
  if (!Array.isArray(graph["nodes"])) graph["nodes"] = []
  if (!Array.isArray(graph["edges"])) graph["edges"] = []

  // variables: objects {name,...}; strings become {name}.
  const variables: JsonObject[] = []
  const seenVariables = new Set<string>()
  const rawVariables = Array.isArray(graph["variables"]) ? (graph["variables"] as unknown[]) : []
  for (const entry of rawVariables) {
    let name: string | undefined
    let object: JsonObject = {}
    if (typeof entry === "string") {
      name = entry
      repairs.push({ code: "VARIABLE_STRING_TO_OBJECT", detail: `variables entry '${entry}' became {name:'${entry}'}` })
    } else if (isObject(entry)) {
      object = entry
      const candidate = entry["name"] ?? entry["id"] ?? entry["key"]
      if (typeof candidate === "string") name = candidate
    }
    if (!name || seenVariables.has(name)) continue
    seenVariables.add(name)
    const normalized: JsonObject = { ...object, name }
    delete normalized["id"]
    delete normalized["key"]
    variables.push(normalized)
  }
  graph["variables"] = variables

  // nodes
  const nodes = nodeList(graph)
  graph["nodes"] = nodes
  nodes.forEach((node, index) => {
    if (node["id"] !== undefined && typeof node["id"] !== "string") node["id"] = String(node["id"])
    const type = typeof node["type"] === "string" ? node["type"] : ""
    const position = node["position"]
    if (!isObject(position) || typeof position["x"] !== "number" || typeof position["y"] !== "number") {
      node["position"] = { x: 260 * index, y: 0 }
      repairs.push({ code: "POSITION_DEFAULTED", detail: `node ${String(node["id"] ?? index)}: position defaulted (layout only)` })
    }
    if (["agent", "condition", "loop", "subworkflow", "output"].includes(type) && typeof node["name"] !== "string") {
      node["name"] = String(node["id"] ?? `node-${index}`)
      repairs.push({ code: "NODE_NAME_DEFAULTED", detail: `node ${String(node["id"] ?? index)}: name defaulted to its id` })
    }
    if (type === "agent") normalizeAgentNode(node, repairs)
    if (type === "condition") normalizeConditionNode(node, repairs)
    if (type === "loop") normalizeLoopNode(node, repairs)
    if (type === "subworkflow") normalizeSubworkflowNode(node, repairs)
  })
  const byId = new Map<string, JsonObject>()
  for (const node of nodes) if (typeof node["id"] === "string") byId.set(node["id"], node)

  // edges
  const edges = edgeList(graph)
  const seenEdgeIds = new Set<string>()
  const seenTriples = new Set<string>()
  const kept: JsonObject[] = []
  for (const edge of edges) {
    if (edge["from"] === undefined && typeof edge["source"] === "string") {
      edge["from"] = edge["source"]
      delete edge["source"]
      repairs.push({ code: "EDGE_SOURCE_TO_FROM", detail: `edge ${String(edge["id"] ?? "?")}: source became from` })
    }
    if (edge["to"] === undefined && typeof edge["target"] === "string") {
      edge["to"] = edge["target"]
      delete edge["target"]
      repairs.push({ code: "EDGE_TARGET_TO_TO", detail: `edge ${String(edge["id"] ?? "?")}: target became to` })
    }
    if (typeof edge["when"] === "string") {
      const lowered = edge["when"].toLowerCase()
      if (!EDGE_WHEN.includes(lowered) && WHEN_SYNONYMS[lowered]) {
        repairs.push({ code: "EDGE_WHEN_SYNONYM", detail: `edge ${String(edge["id"] ?? "?")}: when '${edge["when"]}' became '${WHEN_SYNONYMS[lowered]}'` })
        edge["when"] = WHEN_SYNONYMS[lowered]
      } else if (lowered !== edge["when"] && EDGE_WHEN.includes(lowered)) {
        edge["when"] = lowered
      }
    }
    if (typeof edge["id"] !== "string" || !edge["id"]) {
      edge["id"] = `${String(edge["from"])}->${String(edge["to"])}:${String(edge["when"])}`
      repairs.push({ code: "EDGE_ID_GENERATED", detail: `edge id generated: ${String(edge["id"])}` })
    }
    let edgeId = String(edge["id"])
    while (seenEdgeIds.has(edgeId)) edgeId = `${edgeId}_dup`
    if (edgeId !== edge["id"]) {
      repairs.push({ code: "EDGE_ID_DEDUPED", detail: `duplicate edge id '${String(edge["id"])}' became '${edgeId}'` })
      edge["id"] = edgeId
    }
    seenEdgeIds.add(edgeId)
    const triple = `${String(edge["from"])}|${String(edge["to"])}|${String(edge["when"])}`
    if (seenTriples.has(triple)) {
      repairs.push({ code: "EDGE_DUPLICATE_DROPPED", detail: `edge ${edgeId} duplicated an existing ${String(edge["when"])} edge ${String(edge["from"])}→${String(edge["to"])}` })
      continue
    }
    seenTriples.add(triple)
    kept.push(edge)
  }
  // Rule 2 (EDGE_CARDINALITY): at most one success and one error edge per
  // task node; conditions keep the FIRST true and FIRST false edge.
  const perNodeWhen = new Map<string, Set<string>>()
  const cardinal: JsonObject[] = []
  for (const edge of kept) {
    const from = String(edge["from"])
    const when = String(edge["when"])
    const sourceType = String(byId.get(from)?.["type"] ?? "")
    const bounded =
      (TASK_NODE_TYPES.includes(sourceType) && (when === "success" || when === "error")) ||
      (sourceType === "condition" && (when === "true" || when === "false"))
    if (bounded) {
      const seen = perNodeWhen.get(from) ?? new Set<string>()
      if (seen.has(when)) {
        repairs.push({ code: "EDGE_CARDINALITY_TRIMMED", detail: `edge ${String(edge["id"])}: node ${from} already had a '${when}' edge; the later one was dropped` })
        continue
      }
      seen.add(when)
      perNodeWhen.set(from, seen)
    }
    cardinal.push(edge)
  }
  graph["edges"] = cardinal

  // entry: a single task node with no incoming edge is the only sound default.
  if (typeof graph["entry"] !== "string" || !byId.has(graph["entry"])) {
    const incoming = new Set(cardinal.map((edge) => String(edge["to"])))
    const roots = nodes.filter((node) => TASK_NODE_TYPES.includes(String(node["type"])) && !incoming.has(String(node["id"])))
    if (roots.length === 1) {
      graph["entry"] = String(roots[0]!["id"])
      repairs.push({ code: "ENTRY_INFERRED", detail: `entry set to the only task node without incoming edges: ${String(graph["entry"])}` })
    } else if (typeof head?.["entry"] === "string" && byId.has(head["entry"])) {
      graph["entry"] = head["entry"]
      repairs.push({ code: "ENTRY_FROM_HEAD", detail: `entry restored from the head: ${String(graph["entry"])}` })
    }
  }

  // Rule 6: every referenced variable is declared (a template is a declaration).
  const referenced = new Set<string>()
  for (const node of nodes) {
    const type = String(node["type"])
    if (type === "agent") referencedVariables(node["instruction"], referenced)
    if (type === "loop") referencedVariables(node["item_instruction"], referenced)
    if (type === "subworkflow" && isObject(node["input_mapping"])) {
      for (const value of Object.values(node["input_mapping"])) referencedVariables(value, referenced)
    }
  }
  for (const name of referenced) {
    if (!seenVariables.has(name)) {
      seenVariables.add(name)
      variables.push({ name })
      repairs.push({ code: "VARIABLE_DECLARED", detail: `declared top-level variable {name:'${name}'} for the {{.${name}}} template` })
    }
  }
  return { graph, repairs }
}

// -------------------------------------------------------------------- lint

/** Local mirror of the validator's structural rules (never the authority —
 * the gateway validates again). Catches the common rejections for free. */
export function lintCandidate(graph: unknown): LocalIssue[] {
  const issues: LocalIssue[] = []
  if (!isObject(graph)) return [{ code: "NOT_AN_OBJECT", message: "candidate_graph must be a JSON object" }]
  if (typeof graph["name"] !== "string") issues.push({ code: "NAME_REQUIRED", message: "top-level name is required" })
  const nodes = nodeList(graph)
  const edges = edgeList(graph)
  if (!nodes.length) issues.push({ code: "NODES_REQUIRED", message: "the graph has no nodes" })
  const byId = new Map<string, JsonObject>()
  for (const node of nodes) {
    const id = node["id"]
    if (typeof id !== "string" || !id) {
      issues.push({ code: "NODE_ID_REQUIRED", message: "every node needs a non-empty string id" })
      continue
    }
    if (byId.has(id)) {
      issues.push({ code: "DUP_NODE_ID", message: `Duplicate node id "${id}"`, node_id: id })
      continue
    }
    byId.set(id, node)
    const type = String(node["type"] ?? "")
    if (!KNOWN_NODE_TYPES.includes(type)) {
      issues.push({ code: "UNKNOWN_NODE_TYPE", message: `Unknown node type "${type}" on "${id}"`, node_id: id })
      continue
    }
    const requireString = (field: string) => {
      if (typeof node[field] !== "string" || !(node[field] as string).trim()) {
        issues.push({ code: "FIELD_REQUIRED", message: `${type} node "${id}" is missing required string field '${field}'`, node_id: id })
      }
    }
    if (type === "agent") {
      requireString("name")
      requireString("instruction")
    } else if (type === "condition") {
      requireString("name")
      const check = node["check"]
      if (!isObject(check) || !DETERMINISTIC_CHECK_KINDS.includes(String(check["kind"])) || typeof check["value"] !== "string") {
        issues.push({
          code: "CONDITION_CHECK_INVALID",
          message: `condition node "${id}" needs check:{kind:'url_contains'|'text_present'|'element_exists', value:string}`,
          node_id: id,
        })
      }
    } else if (type === "loop") {
      requireString("name")
      requireString("items_variable")
      requireString("item_instruction")
      const bound = node["max_iterations"]
      if (typeof bound !== "number" || !Number.isInteger(bound) || bound < 1 || bound > 50) {
        issues.push({ code: "LOOP_BOUNDS", message: `Loop node "${id}" max_iterations must be between 1 and 50`, node_id: id })
      }
    } else if (type === "subworkflow") {
      requireString("name")
      requireString("target_agent_id")
    } else if (type === "output") {
      requireString("name")
    }
  }
  const entry = graph["entry"]
  if (typeof entry !== "string" || !byId.has(entry)) {
    issues.push({ code: "ENTRY_MISSING", message: `Entry node "${String(entry)}" does not exist` })
  } else if (!TASK_NODE_TYPES.includes(String(byId.get(entry)!["type"]))) {
    issues.push({ code: "ENTRY_NOT_AGENT", message: `Entry node "${entry}" must be an agent, loop, or subworkflow node`, node_id: entry })
  }

  const outgoing = new Map<string, JsonObject[]>()
  for (const edge of edges) {
    const id = String(edge["id"] ?? "?")
    const from = String(edge["from"])
    const to = String(edge["to"])
    const when = String(edge["when"])
    if (!EDGE_WHEN.includes(when)) {
      issues.push({ code: "EDGE_WHEN_INVALID", message: `Edge "${id}" has when='${when}'; allowed: success, error, true, false`, edge_id: id })
    }
    if (!byId.has(from) || !byId.has(to)) {
      issues.push({ code: "EDGE_ENDPOINT_MISSING", message: `Edge "${id}" references a missing node (${!byId.has(from) ? from : to})`, edge_id: id })
      continue
    }
    const list = outgoing.get(from) ?? []
    list.push(edge)
    outgoing.set(from, list)
  }
  for (const [id, node] of byId) {
    const type = String(node["type"])
    const out = outgoing.get(id) ?? []
    if (TASK_NODE_TYPES.includes(type)) {
      for (const when of ["success", "error"]) {
        if (out.filter((e) => e["when"] === when).length > 1) {
          issues.push({ code: "EDGE_CARDINALITY", message: `${type} node "${id}" has more than one "${when}" edge`, node_id: id })
        }
      }
      if (out.some((e) => e["when"] === "true" || e["when"] === "false")) {
        issues.push({ code: "EDGE_WHEN_MISMATCH", message: `${type} node "${id}" cannot have true/false edges (those are for condition nodes)`, node_id: id })
      }
    } else if (type === "condition") {
      for (const when of ["true", "false"]) {
        if (out.filter((e) => e["when"] === when).length !== 1) {
          issues.push({ code: "CONDITION_EDGES", message: `Condition node "${id}" must have exactly one "${when}" edge`, node_id: id })
        }
      }
      if (out.some((e) => e["when"] === "success" || e["when"] === "error")) {
        issues.push({ code: "EDGE_WHEN_MISMATCH", message: `Condition node "${id}" cannot have success/error edges (use true/false)`, node_id: id })
      }
    } else if (out.length) {
      issues.push({ code: "TERMINAL_OUT_EDGE", message: `Terminal node "${id}" cannot have outgoing edges`, node_id: id })
    }
  }
  // Rule 4: DAG.
  const color = new Map<string, number>()
  const cyclic = (id: string): boolean => {
    color.set(id, 1)
    for (const edge of outgoing.get(id) ?? []) {
      const to = String(edge["to"])
      const c = color.get(to)
      if (c === 1) return true
      if (c === undefined && cyclic(to)) return true
    }
    color.set(id, 2)
    return false
  }
  if ([...byId.keys()].some((id) => !color.has(id) && cyclic(id))) {
    issues.push({ code: "CYCLE", message: "The graph contains a cycle" })
  }
  // Rule 6.
  const declared = new Set<string>()
  for (const entryVar of Array.isArray(graph["variables"]) ? (graph["variables"] as unknown[]) : []) {
    if (isObject(entryVar) && typeof entryVar["name"] === "string") declared.add(entryVar["name"])
  }
  const referenced = new Set<string>()
  for (const node of nodes) {
    const type = String(node["type"])
    if (type === "agent") referencedVariables(node["instruction"], referenced)
    if (type === "loop") referencedVariables(node["item_instruction"], referenced)
    if (type === "subworkflow" && isObject(node["input_mapping"])) {
      for (const value of Object.values(node["input_mapping"])) referencedVariables(value, referenced)
    }
  }
  for (const name of referenced) {
    if (!declared.has(name)) issues.push({ code: "UNDECLARED_VARIABLE", message: `Variable {{.${name}}} is not declared in the graph's variables` })
  }
  // A top-level scripts list is not a contract field: the server would
  // silently ignore it, so the intent (a node's script wiring) would be lost.
  if (Array.isArray(graph["scripts"]) && (graph["scripts"] as unknown[]).length) {
    issues.push({
      code: "TOP_LEVEL_SCRIPTS_IGNORED",
      message: "top-level 'scripts' is not part of the graph contract and would be ignored",
    })
  }
  return issues
}

// ---------------------------------------------------------------- guidance

const GUIDANCE: Record<string, string> = {
  NOT_AN_OBJECT: "Send candidate_graph as a JSON object with version, name, entry, variables, nodes, edges.",
  NAME_REQUIRED: "Add a top-level string 'name'.",
  NODES_REQUIRED: "The graph needs at least one agent node plus success and error terminals.",
  NODE_ID_REQUIRED: "Give every node a non-empty string id and reference nodes by those ids in edges.",
  DUP_NODE_ID: "Two nodes share an id — give the new node a fresh id and update its edges.",
  UNKNOWN_NODE_TYPE: "Node type must be one of agent, condition, loop, subworkflow, success, error, output.",
  FIELD_REQUIRED: "Add the named required field on that node (agent: name+instruction; loop: items_variable+item_instruction+max_iterations; subworkflow: target_agent_id; condition: check).",
  CONDITION_CHECK_INVALID: "A condition node needs check:{kind:'url_contains'|'text_present'|'element_exists', value:'<text>'}; ai_judge is not allowed on conditions.",
  LOOP_BOUNDS: "Set max_iterations to an integer between 1 and 50.",
  ENTRY_MISSING: "Set top-level entry to the id of the first task node (an existing agent/loop/subworkflow id).",
  ENTRY_NOT_AGENT: "entry must point at an agent, loop, or subworkflow node — never a condition or terminal.",
  EDGE_WHEN_INVALID: "Edge when must be 'success' or 'error' (task nodes) or 'true'/'false' (condition nodes).",
  EDGE_ENDPOINT_MISSING: "An edge references a node id that does not exist — keep the ORIGINAL node ids from workflow_head (never rename ids) or fix the edge's from/to.",
  EDGE_CARDINALITY: "A task node may have only ONE success edge and ONE error edge — remove the extra edge.",
  EDGE_WHEN_MISMATCH: "Condition nodes use ONLY true/false edges; agent/loop/subworkflow nodes use ONLY success/error edges. Fix the when of the offending edges.",
  CONDITION_EDGES: "Every condition node needs exactly one 'true' edge and exactly one 'false' edge leaving it.",
  TERMINAL_OUT_EDGE: "success/error terminals cannot have outgoing edges — remove those edges or route from a task node instead.",
  CYCLE: "The graph must be a DAG — remove the edge that loops back (use a loop node for repetition).",
  UNDECLARED_VARIABLE: "Declare every {{.X}} template as a top-level variables entry {name:'X'}.",
  TOP_LEVEL_SCRIPTS_IGNORED: "Attach a script to the TARGET NODE as script:{filepath:'./scripts/<file>.js', failure_action:'fallback_to_ai'} — not as a top-level scripts list.",
  SCHEMA_SOURCE_REQUIRED: "Every input_schema property needs x-source {\"from\":\"run\",\"pointer\":\"/<property>\"}.",
  SCHEMA_SOURCE_INVALID: "x-source must be exactly {\"from\":\"run\",\"pointer\":\"/<property>\"} — no other keys.",
  SCHEMA_KEYWORD_FORBIDDEN: "Use plain JSON Schema (type/properties/required/items) without $ref to external documents or forbidden keywords.",
  SCHEMA_REF_NOT_LOCAL: "Only local '#/…' references are allowed inside a schema.",
  CAPABILITY_UNKNOWN: "The only capabilities are 'browser', 'screen.snapshot', 'screen.computer', 'scripts'.",
  TIMEOUT_INVALID: "Timeouts must be positive and soft_timeout_sec < hard_timeout_sec.",
  NO_FAILURE_PATH: "Transition-mode nodes need an 'ai' edge straight to an error terminal.",
  MIXED_EDGE_MODES: "Do not mix success/error edges with ai/selector edges on one node — use success/error.",
}

const PYDANTIC_REQUIRED = /^(?<path>[\w.\-]+)\n\s+Field required/gm
const PYDANTIC_TYPE = /^(?<path>[\w.\-]+)\n\s+Input should be (?<expect>[^\[\n]+)/gm
const PYDANTIC_TAG = /Input tag '(?<tag>[^']+)' found using 'type' does not match any of the expected tags/

function pydanticGuidance(text: string): string[] {
  const hints: string[] = []
  for (const match of text.matchAll(PYDANTIC_REQUIRED)) {
    const path = match.groups!["path"]!
    if (/scripts\.\d+\.(source|filename)/.test(path)) {
      hints.push(`${path}: you used the plural scripts[] (needs filename AND source). For a script reference use the singular script:{filepath:'./scripts/x.js', failure_action:'fallback_to_ai'}.`)
    } else if (path.endsWith("position")) {
      hints.push(`${path}: every node needs position:{x:<number>, y:<number>}.`)
    } else if (path.endsWith("check")) {
      hints.push(`${path}: condition nodes need check:{kind:'url_contains'|'text_present'|'element_exists', value:'…'}.`)
    } else {
      hints.push(`${path}: this required field is missing — add it to that node/edge.`)
    }
  }
  for (const match of text.matchAll(PYDANTIC_TYPE)) {
    hints.push(`${match.groups!["path"]!}: wrong type — input should be ${match.groups!["expect"]!.trim()}.`)
  }
  const tag = PYDANTIC_TAG.exec(text)
  if (tag) hints.push(`Node type '${tag.groups!["tag"]!}' is not a contract node type (agent, condition, loop, subworkflow, success, error, output).`)
  if (/x-source|DataSource|SCHEMA_SOURCE/.test(text) && !hints.some((h) => h.includes("x-source"))) {
    hints.push(GUIDANCE["SCHEMA_SOURCE_REQUIRED"]!)
  }
  if (/when\n\s+Input should be/.test(text) || /'success', 'error', 'true', 'false'/.test(text)) hints.push(GUIDANCE["EDGE_WHEN_INVALID"]!)
  if (/failure_action/.test(text)) hints.push("script.failure_action must be 'fallback_to_ai' or 'cancel_execution'.")
  if (/capabilit/i.test(text)) hints.push(GUIDANCE["CAPABILITY_UNKNOWN"]!)
  if (/secret literal detected/.test(text)) hints.push("Never put a credential value in the graph — reference secrets as ##NAME## tokens.")
  return hints
}

/** Precise repair instructions for validator issues (local or gateway).
 * Accepts the gateway's mixed shape: issue objects {code,message,…} and
 * raw pydantic error strings. */
export function guidanceFor(issues: readonly unknown[]): string[] {
  const hints: string[] = []
  for (const issue of issues) {
    if (typeof issue === "string") {
      const parsed = pydanticGuidance(issue)
      hints.push(...(parsed.length ? parsed : [issue.slice(0, 300)]))
      continue
    }
    if (!isObject(issue)) continue
    const code = String(issue["code"] ?? "")
    const where = issue["node_id"] ? ` (node ${String(issue["node_id"])})` : issue["edge_id"] ? ` (edge ${String(issue["edge_id"])})` : ""
    const message = typeof issue["message"] === "string" ? issue["message"] : ""
    const hint = GUIDANCE[code] ?? (code.startsWith("SCHEMA_") ? GUIDANCE["SCHEMA_KEYWORD_FORBIDDEN"] : undefined)
    hints.push(hint ? `${code}${where}: ${message ? message + " → " : ""}${hint}` : `${code}${where}: ${message || "fix this validation issue"}`)
  }
  return [...new Set(hints)]
}
