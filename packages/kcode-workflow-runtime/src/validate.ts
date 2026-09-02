/**
 * Static graph validation.
 *
 * This mirrors the reference runtime's `validate_graph` rule for rule, error
 * code for error code, including the rules the neutral wire schema does not
 * carry (time budgets, cycle bounds, reachability, script warnings). The wire
 * validator in `@koracode/kcode-workflow-contracts` stays the shape authority;
 * this is the execution authority layered on top of it.
 */
import { isWorkflowGraph } from "@koracode/kcode-workflow-contracts"
import type { GraphEdge, GraphNode, JsonSchema, JsonValue, WorkflowGraphV1 } from "@koracode/kcode-workflow-contracts"
import { ContractViolation } from "./errors"
import { compareCodePoints, isJsonObject } from "./json"
import { validateSchemaDocument } from "./contracts"
import { isBuiltinVariable, referencedVariables } from "./variables"

export const GRAPH_VERSION = 3
export const knownNodeTypes: readonly string[] = [
  "agent",
  "success",
  "error",
  "condition",
  "loop",
  "subworkflow",
  "output",
]
export const taskNodeTypes: readonly string[] = ["agent", "loop", "subworkflow"]
export const transitionEdgeKinds: readonly string[] = ["ai", "selector"]

/** name -> required dependencies, from the deployment-independent catalog. */
export const capabilityCatalog: ReadonlyMap<string, readonly string[]> = new Map([
  ["browser", []],
  ["screen.snapshot", []],
  ["screen.computer", ["screen.snapshot"]],
  ["scripts", []],
  ["inbox", []],
  ["files", []],
])

const retiredPlaceholder = /__[A-Z0-9_]+__/

export type GraphIssue = {
  readonly code: string
  readonly message: string
  readonly nodeId?: string
  readonly edgeId?: string
}

export type GraphValidation = {
  readonly errors: readonly GraphIssue[]
  readonly warnings: readonly GraphIssue[]
}

export type ValidateOptions = {
  /** The `GRAPH_CYCLIC_EDGES_ENABLED` half of the cycle double opt-in. */
  readonly cyclicEdgesEnabled?: boolean
}

/** v1 and v2 are additive; the upgrade is the version stamp alone. */
export function upgradeGraph<T extends Readonly<Record<string, JsonValue>>>(graph: T): T {
  const version = graph["version"]
  if (typeof version !== "number" || version < GRAPH_VERSION) return { ...graph, version: GRAPH_VERSION }
  return graph
}

export function validateGraph(graph: WorkflowGraphV1, options: ValidateOptions = {}): GraphValidation {
  const errors: GraphIssue[] = []
  const warnings: GraphIssue[] = []
  const byID = new Map<string, GraphNode>()

  for (const node of graph.nodes) {
    if (byID.has(node.id)) {
      errors.push({ code: "DUP_NODE_ID", message: `Duplicate node id "${node.id}"`, nodeId: node.id })
      continue
    }
    byID.set(node.id, node)
    if (!knownNodeTypes.includes(node.type)) {
      errors.push({
        code: "UNKNOWN_NODE_TYPE",
        message: `Unknown node type "${node.type}" on "${node.id}"`,
        nodeId: node.id,
      })
    }
  }

  const entry = byID.get(graph.entry)
  if (entry === undefined) {
    errors.push({ code: "ENTRY_MISSING", message: `Entry node "${graph.entry}" does not exist` })
  } else if (!taskNodeTypes.includes(entry.type)) {
    errors.push({
      code: "ENTRY_NOT_AGENT",
      message: `Entry node "${graph.entry}" must be an agent, loop, or subworkflow node`,
      nodeId: graph.entry,
    })
  }

  const outgoing = new Map<string, GraphEdge[]>()
  for (const edge of graph.edges) {
    if (!byID.has(edge.from) || !byID.has(edge.to)) {
      errors.push({
        code: "EDGE_ENDPOINT_MISSING",
        message: `Edge "${edge.id}" references a missing node`,
        edgeId: edge.id,
      })
      continue
    }
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
  }

  if (
    graph.settings?.timeout_sec !== undefined &&
    graph.settings.timeout_sec !== null &&
    graph.settings.timeout_sec <= 0
  ) {
    errors.push({ code: "TIMEOUT_INVALID", message: "settings.timeout_sec must be > 0" })
  }

  for (const node of graph.nodes) {
    const out = outgoing.get(node.id) ?? []
    if (node.type === "agent") validateAgentBudgets(node, errors, warnings)

    const transitions = out.filter((edge) => transitionEdgeKinds.includes(edge.when))
    if (transitions.length > 0) {
      if (node.type !== "agent") {
        errors.push({
          code: "TRANSITION_EDGE_SOURCE",
          message: `ai/selector edges may only leave an agent node, not "${node.id}" (${node.type})`,
          nodeId: node.id,
        })
      }
      if (out.some((edge) => edge.when === "success" || edge.when === "error")) {
        errors.push({
          code: "MIXED_EDGE_MODES",
          message: `Node "${node.id}" cannot mix classic (success/error) and transition (ai/selector) edges`,
          nodeId: node.id,
        })
      }
      for (const edge of transitions) {
        if (edge.when === "selector" && !(edge.selector ?? "").trim()) {
          errors.push({
            code: "SELECTOR_EDGE_NO_SELECTOR",
            message: `Selector edge "${edge.id}" needs a non-empty selector`,
            edgeId: edge.id,
          })
        }
      }
      if (node.type === "agent") {
        const failurePath = transitions.some((edge) => edge.when === "ai" && byID.get(edge.to)?.type === "error")
        if (!failurePath) {
          errors.push({
            code: "NO_FAILURE_PATH",
            message: `Transition-mode node "${node.id}" needs an ai edge straight to an error terminal`,
            nodeId: node.id,
          })
        }
        const seen = new Set<string>()
        for (const edge of transitions) {
          const target = byID.get(edge.to)
          const handoff = handoffSlug(edge.label ?? nodeName(target) ?? edge.to)
          if (seen.has(handoff)) {
            errors.push({
              code: "DUP_HANDOFF_NAME",
              message: `Two edges from "${node.id}" resolve to the same handoff tool "${handoff}" — set a distinguishing label`,
              edgeId: edge.id,
            })
          }
          seen.add(handoff)
        }
      }
      continue
    }

    if (taskNodeTypes.includes(node.type)) {
      for (const when of ["success", "error"] as const) {
        if (out.filter((edge) => edge.when === when).length > 1) {
          errors.push({
            code: "EDGE_CARDINALITY",
            message: `${capitalize(node.type)} node "${node.id}" has more than one "${when}" edge`,
            nodeId: node.id,
          })
        }
      }
      if (out.some((edge) => edge.when === "true" || edge.when === "false")) {
        errors.push({
          code: "EDGE_WHEN_MISMATCH",
          message: `${capitalize(node.type)} node "${node.id}" cannot have true/false edges (those are for condition nodes)`,
          nodeId: node.id,
        })
      }
      if (!out.some((edge) => edge.when === "success")) {
        warnings.push({
          code: "NO_SUCCESS_EDGE",
          message: `${capitalize(node.type)} node "${node.id}" has no success edge; the run ends there`,
          nodeId: node.id,
        })
      }
      if (node.type === "loop" && !(node.max_iterations >= 1 && node.max_iterations <= 50)) {
        errors.push({
          code: "LOOP_BOUNDS",
          message: `Loop node "${node.id}" max_iterations must be between 1 and 50`,
          nodeId: node.id,
        })
      }
    } else if (node.type === "condition") {
      for (const when of ["true", "false"] as const) {
        if (out.filter((edge) => edge.when === when).length !== 1) {
          errors.push({
            code: "CONDITION_EDGES",
            message: `Condition node "${node.id}" must have exactly one "${when}" edge`,
            nodeId: node.id,
          })
        }
      }
      if (out.some((edge) => edge.when === "success" || edge.when === "error")) {
        errors.push({
          code: "EDGE_WHEN_MISMATCH",
          message: `Condition node "${node.id}" cannot have success/error edges (use true/false)`,
          nodeId: node.id,
        })
      }
    } else if (out.length > 0) {
      errors.push({
        code: "TERMINAL_OUT_EDGE",
        message: `Terminal node "${node.id}" cannot have outgoing edges`,
        nodeId: node.id,
      })
    }
  }

  validateCycles(graph, byID, outgoing, errors, options)
  validateReachability(graph, entry, outgoing, warnings)
  validateVariables(graph, errors)
  validateSchemas(graph, byID, errors)
  return { errors, warnings }
}

function nodeName(node: GraphNode | undefined): string | undefined {
  return node !== undefined && "name" in node ? node.name : undefined
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

export function handoffSlug(targetName: string): string {
  const slug = (targetName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  return `to_${slug || "node"}`
}

function validateAgentBudgets(
  node: Extract<GraphNode, { type: "agent" }>,
  errors: GraphIssue[],
  warnings: GraphIssue[],
): void {
  for (const field of ["soft_timeout_sec", "hard_timeout_sec"] as const) {
    const value = node[field]
    if (value !== undefined && value !== null && value <= 0) {
      errors.push({ code: "TIMEOUT_INVALID", message: `${field} must be > 0 on node "${node.id}"`, nodeId: node.id })
    }
  }
  if (
    node.soft_timeout_sec !== undefined &&
    node.soft_timeout_sec !== null &&
    node.hard_timeout_sec !== undefined &&
    node.hard_timeout_sec !== null &&
    node.soft_timeout_sec >= node.hard_timeout_sec
  ) {
    errors.push({
      code: "TIMEOUT_INVALID",
      message: `soft_timeout_sec must be < hard_timeout_sec on node "${node.id}"`,
      nodeId: node.id,
    })
  }
  if (node.script) {
    const wired = node.script.filepath.split("/").at(-1) ?? ""
    if (!(node.scripts ?? []).some((script) => script.filename === wired)) {
      warnings.push({
        code: "SCRIPT_NOT_FOUND",
        message: `Node "${node.id}" wires script "${wired}" but no scripts[] entry carries its source`,
        nodeId: node.id,
      })
    }
  }
  for (const script of node.scripts ?? []) {
    if (retiredPlaceholder.test(script.source)) {
      warnings.push({
        code: "SCRIPT_RETIRED_PLACEHOLDER",
        message: `Script "${script.filename}" on node "${node.id}" contains a retired __PLACEHOLDER__ — it will fail silently at run time`,
        nodeId: node.id,
      })
    }
  }
}

function validateCycles(
  graph: WorkflowGraphV1,
  byID: ReadonlyMap<string, GraphNode>,
  outgoing: ReadonlyMap<string, readonly GraphEdge[]>,
  errors: GraphIssue[],
  options: ValidateOptions,
): void {
  const color = new Map<string, number>()
  const hasCycleFrom = (nodeID: string): boolean => {
    color.set(nodeID, 1)
    for (const edge of outgoing.get(nodeID) ?? []) {
      const seen = color.get(edge.to)
      if (seen === 1) return true
      if (seen === undefined && hasCycleFrom(edge.to)) return true
    }
    color.set(nodeID, 2)
    return false
  }
  const cyclic = [...byID.keys()].some((nodeID) => !color.has(nodeID) && hasCycleFrom(nodeID))
  if (!cyclic) return

  const allowed = Boolean(graph.settings?.allow_cycles) && Boolean(options.cyclicEdgesEnabled)
  if (!allowed) {
    errors.push({
      code: "CYCLE",
      message:
        "The graph contains a cycle (set settings.allow_cycles and enable GRAPH_CYCLIC_EDGES_ENABLED to permit bounded loops)",
    })
    return
  }
  const visits = graph.settings?.max_node_visits
  if (visits === undefined || visits === null || !(visits >= 1 && visits <= 100)) {
    errors.push({ code: "CYCLE_NO_VISIT_BOUND", message: "Cyclic graphs must set settings.max_node_visits (1..100)" })
  }
  if (!graph.settings?.timeout_sec) {
    errors.push({ code: "CYCLE_NO_TIMEOUT", message: "Cyclic graphs must set settings.timeout_sec" })
  }
  for (const component of nontrivialComponents(byID, outgoing)) {
    const hasDecisionPoint = [...component].some(
      (nodeID) =>
        byID.get(nodeID)?.type === "agent" &&
        (outgoing.get(nodeID) ?? []).some((edge) => transitionEdgeKinds.includes(edge.when)),
    )
    if (!hasDecisionPoint) {
      errors.push({
        code: "CYCLE_NO_DECISION_POINT",
        message:
          "A loop must pass through at least one transition-mode agent node (ai/selector edges) so the model or a selector can exit it",
        nodeId: [...component].toSorted(compareCodePoints)[0],
      })
    }
  }
}

/** Tarjan, iterative. Non-trivial means a real loop: more than one node, or a self-edge. */
function nontrivialComponents(
  byID: ReadonlyMap<string, GraphNode>,
  outgoing: ReadonlyMap<string, readonly GraphEdge[]>,
): readonly ReadonlySet<string>[] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const components: Set<string>[] = []
  let counter = 0
  const targets = (nodeID: string): string[] =>
    (outgoing.get(nodeID) ?? []).filter((edge) => byID.has(edge.to)).map((edge) => edge.to)

  for (const root of byID.keys()) {
    if (index.has(root)) continue
    index.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)
    const work: { node: string; children: string[]; cursor: number }[] = [
      { node: root, children: targets(root), cursor: 0 },
    ]
    while (work.length > 0) {
      const frame = work[work.length - 1]
      if (frame === undefined) break
      let pushed = false
      while (frame.cursor < frame.children.length) {
        const child = frame.children[frame.cursor] ?? ""
        frame.cursor += 1
        if (!index.has(child)) {
          index.set(child, counter)
          low.set(child, counter)
          counter += 1
          stack.push(child)
          onStack.add(child)
          work.push({ node: child, children: targets(child), cursor: 0 })
          pushed = true
          break
        }
        if (onStack.has(child)) low.set(frame.node, Math.min(low.get(frame.node) ?? 0, index.get(child) ?? 0))
      }
      if (pushed) continue
      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0))
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = new Set<string>()
        for (;;) {
          const member = stack.pop()
          if (member === undefined) break
          onStack.delete(member)
          component.add(member)
          if (member === frame.node) break
        }
        if (component.size > 1 || targets(frame.node).includes(frame.node)) components.push(component)
      }
    }
  }
  return components
}

function validateReachability(
  graph: WorkflowGraphV1,
  entry: GraphNode | undefined,
  outgoing: ReadonlyMap<string, readonly GraphEdge[]>,
  warnings: GraphIssue[],
): void {
  if (entry === undefined) return
  const seen = new Set([graph.entry])
  const stack = [graph.entry]
  while (stack.length > 0) {
    const current = stack.pop() ?? ""
    for (const edge of outgoing.get(current) ?? []) {
      if (!seen.has(edge.to)) {
        seen.add(edge.to)
        stack.push(edge.to)
      }
    }
  }
  for (const node of graph.nodes) {
    if (!seen.has(node.id)) {
      warnings.push({
        code: "UNREACHABLE",
        message: `Node "${node.id}" is not reachable from the entry`,
        nodeId: node.id,
      })
    }
  }
}

export function extractVariables(graph: WorkflowGraphV1): readonly string[] {
  const found: string[] = []
  const scan = (text: string): void => {
    for (const name of referencedVariables(text)) {
      if (!isBuiltinVariable(name) && !found.includes(name)) found.push(name)
    }
  }
  for (const node of graph.nodes) {
    if (node.type === "agent") scan(node.instruction)
    else if (node.type === "loop") scan(node.item_instruction)
    else if (node.type === "subworkflow") Object.values(node.input_mapping ?? {}).forEach(scan)
  }
  return found
}

function validateVariables(graph: WorkflowGraphV1, errors: GraphIssue[]): void {
  const declared = new Set((graph.variables ?? []).map((variable) => variable.name))
  for (const name of extractVariables(graph)) {
    if (!declared.has(name)) {
      errors.push({
        code: "UNDECLARED_VARIABLE",
        message: `Variable {{.${name}}} is not declared in the graph's variables`,
      })
    }
  }
}

function validateSchemas(graph: WorkflowGraphV1, byID: ReadonlyMap<string, GraphNode>, errors: GraphIssue[]): void {
  const check = (
    schema: JsonSchema | null | undefined,
    options: {
      readonly location: string
      readonly nodeId?: string
      readonly edgeId?: string
      readonly objectRoot?: boolean
      readonly requireSources?: boolean
    },
  ): void => {
    if (schema === null || schema === undefined) return
    try {
      validateSchemaDocument(schema, {
        location: options.location,
        objectRoot: options.objectRoot,
        requireSources: options.requireSources,
      })
    } catch (error) {
      if (!(error instanceof ContractViolation)) throw error
      errors.push({ code: error.code, message: error.message, nodeId: options.nodeId, edgeId: options.edgeId })
    }
  }

  check(graph.input_schema, { location: "graph/input_schema", objectRoot: true })
  for (const node of graph.nodes) {
    if (node.type === "agent") {
      validateCapabilities(node.capabilities, node.id, errors)
      check(node.input_schema, {
        location: `nodes/${node.id}/input_schema`,
        nodeId: node.id,
        objectRoot: true,
        requireSources: true,
      })
    } else if (node.type === "output") {
      check(node.output_schema, { location: `nodes/${node.id}/output_schema`, nodeId: node.id })
      if (node.output_binding) {
        if (node.output_binding.from === "node" && !byID.has(node.output_binding.node_id ?? "")) {
          errors.push({
            code: "SOURCE_NODE_MISSING",
            message: `Output node "${node.id}" references a missing source node`,
            nodeId: node.id,
          })
        }
        if (
          node.output_binding.from === "edge" &&
          !graph.edges.some((edge) => edge.id === node.output_binding?.edge_id)
        ) {
          errors.push({
            code: "SOURCE_EDGE_MISSING",
            message: `Output node "${node.id}" references a missing source edge`,
            nodeId: node.id,
          })
        }
      }
    }
  }
  for (const edge of graph.edges) {
    check(edge.transition_schema, { location: `edges/${edge.id}/transition_schema`, edgeId: edge.id, objectRoot: true })
  }
}

function validateCapabilities(
  capabilities: readonly string[] | null | undefined,
  nodeId: string,
  errors: GraphIssue[],
): void {
  if (capabilities === null || capabilities === undefined) return
  const requested = new Set(capabilities)
  const ordered = [...requested].toSorted(compareCodePoints)
  for (const capability of ordered) {
    if (!capabilityCatalog.has(capability)) {
      errors.push({ code: "CAPABILITY_UNKNOWN", message: `CAPABILITY_UNKNOWN: ${capability}`, nodeId })
      return
    }
  }
  for (const capability of ordered) {
    const missing = (capabilityCatalog.get(capability) ?? []).filter((name) => !requested.has(name))
    if (missing.length > 0) {
      const first = missing.toSorted(compareCodePoints)[0]
      errors.push({
        code: "CAPABILITY_DEPENDENCY_MISSING",
        message: `CAPABILITY_DEPENDENCY_MISSING: ${capability} -> ${first}`,
        nodeId,
      })
      return
    }
  }
}

/**
 * Accept a graph only when both authorities accept it: the neutral wire schema
 * and the execution rules above.
 */
export function acceptsGraph(graph: Readonly<Record<string, JsonValue>>, options: ValidateOptions = {}): boolean {
  if (!isJsonObject(graph) || !isWorkflowGraph(graph)) return false
  return validateGraph(graph, options).errors.length === 0
}
