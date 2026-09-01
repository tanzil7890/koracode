import Ajv2020 from "ajv/dist/2020.js"
import artifactSchema from "../contract/schemas/artifact-manifest.v1.schema.json" with { type: "json" }
import definitionSchema from "../contract/schemas/definition-bundle.v1.schema.json" with { type: "json" }
import eventSchema from "../contract/schemas/run-event.v1.schema.json" with { type: "json" }
import interactionSchema from "../contract/schemas/interaction.v1.schema.json" with { type: "json" }
import resultSchema from "../contract/schemas/runtime-result.v1.schema.json" with { type: "json" }
import workflowSchema from "../contract/schemas/workflow-graph.v1.schema.json" with { type: "json" }
import type {
  AgentNode,
  DataSource,
  GraphEdge,
  GraphNode,
  JsonSchema,
  RunEventV1,
  WorkflowInteractionV1,
  WorkflowGraphV1,
} from "../contract/generated/workflow-protocol"

export type ProtocolIssue = { readonly code: string; readonly location: string }
export type ProtocolValidation = { readonly valid: boolean; readonly issues: readonly ProtocolIssue[] }

const ajv = new Ajv2020({ allErrors: true, strict: true, strictSchema: false, validateFormats: false })
const validateWire = ajv.compile<WorkflowGraphV1>(workflowSchema)
const validateEventWire = ajv.compile(eventSchema)
const validateInteractionWire = ajv.compile<WorkflowInteractionV1>(interactionSchema)
const validateResultWire = ajv.compile(resultSchema)
const validateArtifactWire = ajv.compile(artifactSchema)
const validateDefinitionWire = ajv.compile(definitionSchema)
const capabilities = new Map<string, readonly string[]>([
  ["browser", []],
  ["screen.snapshot", []],
  ["screen.computer", ["screen.snapshot"]],
  ["scripts", []],
  ["inbox", []],
  ["files", []],
] as const)
const taskTypes = new Set<GraphNode["type"]>(["agent", "loop", "subworkflow"])
const transitionKinds = new Set<GraphEdge["when"]>(["ai", "selector"])

export function validateWorkflowGraph(input: unknown): ProtocolValidation {
  if (!validateWire(input)) {
    return {
      valid: false,
      issues: (validateWire.errors ?? []).map((error) => ({
        code: "SCHEMA_SHAPE_INVALID",
        location: error.instancePath || "/",
      })),
    }
  }
  const issues = validateSemantics(input)
  return { valid: issues.length === 0, issues }
}

export function isWorkflowGraph(input: unknown): input is WorkflowGraphV1 {
  return validateWorkflowGraph(input).valid
}

export function upgradeGraph(graph: WorkflowGraphV1): WorkflowGraphV1 {
  if ((graph.version ?? 1) < 3) return { ...graph, version: 3 }
  return graph
}

export function validateRunEvent(input: unknown) {
  return wireResult(validateEventWire(input), validateEventWire.errors)
}

export function isRunEvent(input: unknown): input is RunEventV1 {
  return validateEventWire(input)
}

export function validateRuntimeResult(input: unknown) {
  return wireResult(validateResultWire(input), validateResultWire.errors)
}

export function validateWorkflowInteraction(input: unknown) {
  return wireResult(validateInteractionWire(input), validateInteractionWire.errors)
}

export function isWorkflowInteraction(input: unknown): input is WorkflowInteractionV1 {
  return validateInteractionWire(input)
}

export function validateArtifactManifest(input: unknown) {
  return wireResult(validateArtifactWire(input), validateArtifactWire.errors)
}

export function validateDefinitionBundle(input: unknown) {
  return wireResult(validateDefinitionWire(input), validateDefinitionWire.errors)
}

function validateSemantics(graph: WorkflowGraphV1) {
  const issues: ProtocolIssue[] = []
  const byID = new Map<string, GraphNode>()
  graph.nodes.forEach((node) => {
    if (byID.has(node.id)) issues.push({ code: "DUP_NODE_ID", location: `/nodes/${node.id}` })
    byID.set(node.id, node)
  })
  const entry = byID.get(graph.entry)
  if (!entry) issues.push({ code: "ENTRY_MISSING", location: "/entry" })
  else if (!taskTypes.has(entry.type)) issues.push({ code: "ENTRY_NOT_AGENT", location: "/entry" })

  const outgoing = new Map<string, GraphEdge[]>()
  graph.edges.forEach((edge) => {
    if (!byID.has(edge.from) || !byID.has(edge.to)) {
      issues.push({ code: "EDGE_ENDPOINT_MISSING", location: `/edges/${edge.id}` })
      return
    }
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge])
  })

  if (graph.input_schema) validateNestedSchema(graph.input_schema, "/input_schema", issues, true, false)
  graph.nodes.forEach((node) => validateNode(node, graph, byID, outgoing, issues))
  graph.edges.forEach((edge) => {
    if (edge.transition_schema)
      validateNestedSchema(edge.transition_schema, `/edges/${edge.id}/transition_schema`, issues, true, false)
  })
  if (hasCycle(graph.entry, outgoing) && !graph.settings?.allow_cycles) {
    issues.push({ code: "CYCLE", location: "/edges" })
  }
  validateVariables(graph, issues)
  return issues
}

function validateNode(
  node: GraphNode,
  graph: WorkflowGraphV1,
  byID: ReadonlyMap<string, GraphNode>,
  outgoing: ReadonlyMap<string, readonly GraphEdge[]>,
  issues: ProtocolIssue[],
) {
  const edges = outgoing.get(node.id) ?? []
  if (node.type === "agent") validateAgent(node, edges, byID, issues)
  if (node.type === "condition") {
    ;(["true", "false"] as const).forEach((when) => {
      if (edges.filter((edge) => edge.when === when).length !== 1) {
        issues.push({ code: "CONDITION_EDGES", location: `/nodes/${node.id}` })
      }
    })
  }
  if (node.type === "loop" && (node.max_iterations < 1 || node.max_iterations > 50)) {
    issues.push({ code: "LOOP_BOUNDS", location: `/nodes/${node.id}` })
  }
  if (!taskTypes.has(node.type) && node.type !== "condition" && edges.length > 0) {
    issues.push({ code: "TERMINAL_OUT_EDGE", location: `/nodes/${node.id}` })
  }
  if (node.type !== "output") return
  if (node.output_schema)
    validateNestedSchema(node.output_schema, `/nodes/${node.id}/output_schema`, issues, false, false)
  if (node.output_binding?.from === "node" && !byID.has(node.output_binding.node_id ?? "")) {
    issues.push({ code: "SOURCE_NODE_MISSING", location: `/nodes/${node.id}/output_binding` })
  }
  if (node.output_binding?.from === "edge" && !graph.edges.some((edge) => edge.id === node.output_binding?.edge_id)) {
    issues.push({ code: "SOURCE_EDGE_MISSING", location: `/nodes/${node.id}/output_binding` })
  }
}

function validateAgent(
  node: AgentNode,
  edges: readonly GraphEdge[],
  byID: ReadonlyMap<string, GraphNode>,
  issues: ProtocolIssue[],
) {
  if (node.capabilities) {
    const requested = new Set(node.capabilities)
    node.capabilities.forEach((capability) => {
      const required = capabilities.get(capability)
      if (!required) {
        issues.push({ code: "CAPABILITY_UNKNOWN", location: `/nodes/${node.id}/capabilities` })
        return
      }
      required.forEach((dependency) => {
        if (!requested.has(dependency)) {
          issues.push({ code: "CAPABILITY_DEPENDENCY_MISSING", location: `/nodes/${node.id}/capabilities` })
        }
      })
    })
  }
  if (node.input_schema) validateNestedSchema(node.input_schema, `/nodes/${node.id}/input_schema`, issues, true, true)
  const transitions = edges.filter((edge) => transitionKinds.has(edge.when))
  if (transitions.length === 0) {
    ;(["success", "error"] as const).forEach((when) => {
      if (edges.filter((edge) => edge.when === when).length > 1) {
        issues.push({ code: "EDGE_CARDINALITY", location: `/nodes/${node.id}` })
      }
    })
    if (edges.some((edge) => edge.when === "true" || edge.when === "false")) {
      issues.push({ code: "EDGE_WHEN_MISMATCH", location: `/nodes/${node.id}` })
    }
    return
  }
  if (edges.some((edge) => edge.when === "success" || edge.when === "error")) {
    issues.push({ code: "MIXED_EDGE_MODES", location: `/nodes/${node.id}` })
  }
  if (!transitions.some((edge) => edge.when === "ai" && byID.get(edge.to)?.type === "error")) {
    issues.push({ code: "NO_FAILURE_PATH", location: `/nodes/${node.id}` })
  }
  const names = transitions.map((edge) => handoffName(edge.label ?? byID.get(edge.to)?.id ?? edge.to))
  if (new Set(names).size !== names.length) issues.push({ code: "DUP_HANDOFF_NAME", location: `/nodes/${node.id}` })
  transitions.forEach((edge) => {
    if (edge.when === "selector" && !edge.selector?.trim()) {
      issues.push({ code: "SELECTOR_EDGE_NO_SELECTOR", location: `/edges/${edge.id}` })
    }
  })
}

function validateNestedSchema(
  schema: JsonSchema,
  location: string,
  issues: ProtocolIssue[],
  objectRoot: boolean,
  requireSources: boolean,
) {
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > 64 * 1024) {
    issues.push({ code: "SCHEMA_TOO_LARGE", location })
    return
  }
  if (objectRoot && schema.type !== "object") issues.push({ code: "SCHEMA_ROOT_NOT_OBJECT", location })
  walkSchema(schema, location, issues)
  if (!ajv.validateSchema(schema, true)) issues.push({ code: "SCHEMA_INVALID", location })
  if (!requireSources) return
  const properties = isRecord(schema.properties) ? schema.properties : {}
  Object.entries(properties).forEach(([name, value]) => {
    if (!isRecord(value) || !isDataSource(value["x-source"])) {
      issues.push({ code: "SCHEMA_SOURCE_REQUIRED", location: `${location}/properties/${name}` })
    }
  })
}

function walkSchema(value: unknown, location: string, issues: ProtocolIssue[], depth = 0) {
  if (depth > 32) {
    issues.push({ code: "SCHEMA_TOO_DEEP", location })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((child) => walkSchema(child, location, issues, depth + 1))
    return
  }
  if (!isRecord(value)) return
  if (isRecord(value.properties) && Object.keys(value.properties).length > 512) {
    issues.push({ code: "SCHEMA_TOO_MANY_PROPERTIES", location })
  }
  Object.entries(value).forEach(([key, child]) => {
    if (["$dynamicRef", "$dynamicAnchor", "contentSchema"].includes(key)) {
      issues.push({ code: "SCHEMA_KEYWORD_FORBIDDEN", location })
    }
    if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/"))) {
      issues.push({ code: "SCHEMA_REF_NOT_LOCAL", location })
    }
    if (key === "pattern" && (typeof child !== "string" || child.length > 512)) {
      issues.push({ code: "SCHEMA_REGEX_TOO_LONG", location })
    }
    if (key === "patternProperties" && isRecord(child) && Object.keys(child).some((pattern) => pattern.length > 512)) {
      issues.push({ code: "SCHEMA_REGEX_TOO_LONG", location })
    }
    walkSchema(child, location, issues, depth + 1)
  })
}

function isDataSource(value: unknown): value is DataSource {
  if (!isRecord(value) || !["run", "previous", "node", "edge"].includes(String(value.from))) return false
  if (value.from === "node" && typeof value.node_id !== "string") return false
  if (value.from === "edge" && typeof value.edge_id !== "string") return false
  if ((value.from === "run" || value.from === "previous") && (value.node_id || value.edge_id)) return false
  if (value.selection === "current" && value.from !== "run" && value.from !== "previous") return false
  return true
}

function validateVariables(graph: WorkflowGraphV1, issues: ProtocolIssue[]) {
  const declared = new Set((graph.variables ?? []).map((variable) => variable.name))
  const used = graph.nodes.flatMap((node) => {
    if (node.type === "agent") return variables(node.instruction)
    if (node.type === "loop") return variables(node.item_instruction)
    if (node.type === "subworkflow") return Object.values(node.input_mapping ?? {}).flatMap(variables)
    return []
  })
  used.forEach((name) => {
    if (!isBuiltin(name) && !declared.has(name)) issues.push({ code: "UNDECLARED_VARIABLE", location: "/variables" })
  })
}

function variables(value: string) {
  return Array.from(value.matchAll(/\{\{\.([A-Z0-9_]+)\}\}/g), (match) => match[1]).filter(
    (name): name is string => name !== undefined,
  )
}

function isBuiltin(name: string) {
  return ["PREV_OUTPUT", "ITEM", "ITEM_INDEX"].includes(name) || (name.startsWith("NODE_") && name.endsWith("_OUTPUT"))
}

function hasCycle(entry: string, outgoing: ReadonlyMap<string, readonly GraphEdge[]>) {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true
    if (visited.has(node)) return false
    visiting.add(node)
    const cyclic = (outgoing.get(node) ?? []).some((edge) => visit(edge.to))
    visiting.delete(node)
    visited.add(node)
    return cyclic
  }
  return visit(entry)
}

function handoffName(value: string) {
  return `to_${
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "") || "node"
  }`
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function wireResult(
  valid: boolean,
  errors: undefined | null | readonly { readonly instancePath: string }[],
): ProtocolValidation {
  return {
    valid,
    issues: valid
      ? []
      : (errors ?? []).map((error) => ({ code: "SCHEMA_SHAPE_INVALID", location: error.instancePath || "/" })),
  }
}
