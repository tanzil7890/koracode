/**
 * The compiler: everything decidable before a node runs.
 *
 * Compilation takes an immutable bundle and either refuses it with a stable
 * code or hands back a program the state machine can walk without ever
 * consulting a mutable head. Refusing early is the point: an unsatisfiable
 * definition must never reach a terminal reason, because a terminal reason
 * claims the run happened.
 */
import { isWorkflowGraph, validateWorkflowGraph } from "@koracode/kcode-workflow-contracts"
import type { JsonValue, WorkflowGraphV1 } from "@koracode/kcode-workflow-contracts"
import { DefinitionResolver, contentDigest, verifyDefinitionBundle } from "./bundle"
import type { DefinitionBundle } from "./bundle"
import { CompileError, ContractViolation } from "./errors"
import { validateInstance, validateSchemaDocument } from "./contracts"
import { acceptsGraph, upgradeGraph, validateGraph } from "./validate"
import type { GraphIssue, ValidateOptions } from "./validate"

export type CompileOptions = ValidateOptions & {
  /**
   * Opt-in: refuse a bundle whose recursion the walker could not finish.
   *
   * Left unset by default, because the reference runtime does NOT refuse such
   * a definition — it walks until the depth guard trips and reports a node
   * failure — and a candidate engine that refused earlier would disagree with
   * it on a real definition.
   */
  readonly maxSubworkflowDepth?: number
}

export type CompiledProgram = {
  readonly bundle: DefinitionBundle
  readonly resolver: DefinitionResolver
  readonly rootAgentID: string
  readonly rootGraph: WorkflowGraphV1
  readonly rootDigest: string
  readonly bundleDigest: string
  readonly declaredVariables: readonly string[]
  readonly requiredVariables: readonly string[]
  readonly warnings: readonly GraphIssue[]
}

export type PreflightIssue = { readonly code: string; readonly location: string; readonly message: string }

export type PreflightResult = { readonly ok: boolean; readonly issues: readonly PreflightIssue[] }

/**
 * Compile a bundle. Every refusal is a `CompileError` carrying the same code the
 * reference authoring and admission boundaries use.
 */
export function compile(bundle: DefinitionBundle, options: CompileOptions = {}): CompiledProgram {
  const validateOptions: ValidateOptions = { cyclicEdgesEnabled: options.cyclicEdgesEnabled }
  const maxRuntimeDepth = options.maxSubworkflowDepth

  for (const member of bundle.members) {
    const wire = validateWorkflowGraph(member.graph)
    if (!wire.valid) {
      const first = wire.issues[0]
      throw new CompileError(first?.code ?? "SCHEMA_SHAPE_INVALID", `members/${member.path.join("/") || "root"}`)
    }
    if (!isWorkflowGraph(member.graph)) {
      throw new CompileError("SCHEMA_SHAPE_INVALID", `members/${member.path.join("/") || "root"}`)
    }
    const semantic = validateGraph(member.graph, validateOptions)
    if (semantic.errors.length > 0) {
      const first = semantic.errors[0]
      throw new CompileError(
        first?.code ?? "GRAPH_INVALID",
        `members/${member.path.join("/") || "root"}`,
        first?.message,
      )
    }
  }

  verifyDefinitionBundle(bundle, { isValidGraph: (graph) => acceptsGraph(graph, validateOptions) })

  if (maxRuntimeDepth !== undefined) {
    const deepest = Math.max(0, ...bundle.members.map((member) => member.path.length))
    if (deepest >= maxRuntimeDepth) {
      throw new CompileError(
        "SUBWORKFLOW_DEPTH_EXCEEDED",
        "members",
        `definition nests ${deepest} level(s); the runtime walker permits ${maxRuntimeDepth - 1}`,
      )
    }
  }

  const resolver = new DefinitionResolver(bundle, { isValidGraph: (graph) => acceptsGraph(graph, validateOptions) })
  const rootGraph = resolver.root()
  const warnings = validateGraph(rootGraph, validateOptions).warnings
  const variables = rootGraph.variables ?? []
  return {
    bundle,
    resolver,
    rootAgentID: bundle.rootAgentId,
    rootGraph,
    rootDigest: resolver.member([]).graphDigest,
    bundleDigest: bundle.digest,
    declaredVariables: variables.map((variable) => variable.name),
    requiredVariables: variables.filter((variable) => variable.required !== false).map((variable) => variable.name),
    warnings,
  }
}

/**
 * Check a run's inputs against the compiled program without running anything.
 *
 * A missing required variable and an input document that violates the graph's
 * declared schema are both refusals, reported together so an operator sees the
 * whole story at once.
 */
export function preflight(program: CompiledProgram, runInput: Readonly<Record<string, JsonValue>>): PreflightResult {
  const issues: PreflightIssue[] = []
  for (const name of program.requiredVariables) {
    if (!Object.hasOwn(runInput, name)) {
      issues.push({
        code: "INPUT_REQUIRED",
        location: `run_input/${name}`,
        message: `required variable ${name} is absent`,
      })
    }
  }
  const schema = program.rootGraph.input_schema
  if (schema) {
    try {
      validateInstance(
        runInput,
        validateSchemaDocument(schema, { location: "graph/input_schema", objectRoot: true }),
        "run_input",
      )
    } catch (error) {
      if (!(error instanceof ContractViolation)) throw error
      issues.push({ code: error.code, location: error.location, message: error.message })
    }
  }
  return { ok: issues.length === 0, issues }
}

/** Canonical digest of a graph document, after the additive version upgrade. */
export function graphDigest(graph: Readonly<Record<string, JsonValue>>): string {
  return contentDigest(upgradeGraph(graph))
}
