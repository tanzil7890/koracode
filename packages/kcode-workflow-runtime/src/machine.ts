/**
 * The graph state machine.
 *
 * `walkGraph` is a generator: it yields an action request whenever it needs the
 * world to answer something, and resumes with the outcome. Every other decision
 * — which edge, which terminal, which limit, which latch — is made here, from
 * the immutable definition and the run's own history. Nothing in this file
 * reads a clock, a file, a socket, or a global.
 *
 * The control flow, the order of its checks, and its exact error strings mirror
 * the reference runtime's `_walk_graph`, including the places where that order
 * is surprising. Those are marked where they matter.
 */
import type { GraphEdge, GraphNode, JsonValue, WorkflowGraphV1 } from "@koracode/kcode-workflow-contracts"
import type { ActionOutcome, ActionRequest, CheckOutcome, ReplayOutcome } from "./actions"
import { answer, asCheckOutcome, asReplayOutcome, asTaskOutcome, normalizeTaskOutcome } from "./actions"
import type { ActionPort } from "./actions"
import { instructionHash } from "./hash"
import { ContractViolation, DataResolutionError, KernelError } from "./errors"
import { ExecutionContext, edgeKey, instanceKey } from "./context"
import { DecisionEventLog, definitionNodeKey } from "./events"
import type { Clock } from "./events"
import { isJsonObject, orEmpty, preview, pythonJson, pythonRepr, pythonStr } from "./json"
import { resolveNodeInputs, validateOutput } from "./contracts"
import { TerminationReason, outcomeLabelFor, runTerminationReason } from "./terminal"
import type { LifecycleStatus } from "./terminal"
import { findSecretTokens, renderPromptText } from "./variables"
import type { DefinitionResolver } from "./bundle"

export const MAX_SUBWORKFLOW_DEPTH = 3
export const DEFAULT_MAX_GRAPH_STEPS = 1000
export const NODE_LOG_CAP = 50

export const SCOPED_PREAMBLE =
  "You are executing ONE step of a larger workflow. Complete ONLY this step, then stop.\n" +
  "Do not navigate beyond what this step requires. Do not attempt subsequent steps.\n" +
  "If this step cannot be completed as described (e.g. a login is rejected), do not improvise — " +
  "finish and report failure so the workflow can take its error path.\n"

export const SECRET_PREAMBLE =
  "Values written as ##NAME## are secret placeholders. You never know their real values; " +
  "to enter one, use the secret-placeholder mechanism you have been given.\n"

export type NodeLogLine = { readonly at: number; readonly message: string }

export type NodeState = {
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  mode?: "agent" | "deterministic"
  output?: JsonValue
  error?: string | null
  logs: NodeLogLine[]
  startedAt?: number
  finishedAt?: number
}

export type WalkResult = {
  readonly status: LifecycleStatus
  readonly error: string | null
  readonly lastOutput: JsonValue
}

/** Host-controlled switches that a deployment flag would decide in production. */
export type RuntimeFlags = {
  readonly nodeLoopEnabled?: boolean
  readonly nodeLoopTimeoutsEnabled?: boolean
  readonly cyclicEdgesEnabled?: boolean
}

export type RunSite = {
  readonly nodeKey: string
  readonly nodeId: string
  readonly definitionPath: readonly string[]
}

export type RunOptions = {
  readonly runID: string
  readonly attemptID?: string | null
  readonly resolver: DefinitionResolver
  readonly rootAgentID: string
  readonly runInput?: Readonly<Record<string, JsonValue>>
  readonly clock: Clock
  readonly flags?: RuntimeFlags
  /** Names whose values must never be rendered into an instruction. */
  readonly secretNames?: readonly string[]
  /** Cooperative cancellation, polled exactly where the reference runtime polls it. */
  readonly isCancelled?: () => boolean
  /** The safe pause boundary. Returns true when a pause actually happened. */
  readonly atSafePoint?: (site: RunSite) => boolean
  /** Model-alias resolution; false produces the same contract-violation terminal. */
  readonly resolveModel?: (alias: string | null) => boolean
}

export type RunResult = {
  readonly status: LifecycleStatus
  readonly terminationReason: TerminationReason
  readonly outcomeLabel: ReturnType<typeof outcomeLabelFor>
  readonly error: string | null
  readonly output: JsonValue
  readonly outputNodeID: string | null
  readonly events: readonly import("@koracode/kcode-workflow-contracts").RunEventV1[]
  readonly nodeStates: Readonly<Record<string, NodeState>>
}

type RunControl = {
  latched: TerminationReason | null
  finalOutput: JsonValue
  outputNodeID: string | null
  runDeadlineMs: number | null
  readonly events: DecisionEventLog
  readonly nodeStates: Map<string, NodeState>
  readonly options: RunOptions
  readonly secretNames: ReadonlySet<string>
  cancelled: boolean
}

function latch(control: RunControl, reason: TerminationReason): void {
  if (control.latched === null) control.latched = reason
}

function nodeState(control: RunControl, key: string): NodeState {
  const existing = control.nodeStates.get(key)
  if (existing !== undefined) return existing
  const created: NodeState = { status: "queued", logs: [] }
  control.nodeStates.set(key, created)
  return created
}

function log(control: RunControl, key: string, message: string): void {
  const state = nodeState(control, key)
  state.logs.push({ at: control.options.clock.monotonicMs(), message })
  if (state.logs.length > NODE_LOG_CAP) state.logs.splice(0, state.logs.length - NODE_LOG_CAP)
}

/**
 * `verdict` is a box rather than a bare value because the reference payload
 * distinguishes three things: a verdict of true, a verdict of false, a verdict
 * of "never finished" (null), and NO verdict at all (the key is absent). Only a
 * caller that actually ran an agent pass supplies one.
 */
function finishNode(
  control: RunControl,
  key: string,
  startedMs: number,
  extra: { readonly tokens?: number | null; readonly verdict?: { readonly value: boolean | null } } = {},
): void {
  const state = nodeState(control, key)
  const payload: Record<string, JsonValue> = {
    status: state.status,
    mode: state.mode ?? null,
    duration_ms: Math.trunc(control.options.clock.monotonicMs() - startedMs),
    output_preview: preview(state.output),
    error: preview(state.error ?? null),
  }
  if (extra.tokens) payload["tokens"] = extra.tokens
  if (extra.verdict !== undefined) payload["is_successful"] = extra.verdict.value
  control.events.emit(key, "node_finished", payload)
}

function isCancelled(control: RunControl): boolean {
  if (control.cancelled) return true
  if (control.options.isCancelled?.() === true) {
    control.cancelled = true
    return true
  }
  return false
}

/**
 * A loop consumes native arrays; legacy newline and JSON strings still load.
 * Falling through a failed JSON parse to line splitting is deliberate.
 */
export function parseItems(raw: JsonValue | undefined): readonly JsonValue[] {
  if (Array.isArray(raw)) return [...raw]
  if (raw === null || raw === undefined) return []
  const text = pythonStr(raw).trim()
  if (text.startsWith("[")) {
    try {
      const parsed: JsonValue = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      // fall through to line splitting
    }
  }
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/**
 * `json.loads`. `JSON.parse` only ever yields a JSON value, and a malformed
 * document throws, which is precisely what the output node converts into a
 * schema-validation terminal.
 */
function parseJson(text: string): JsonValue {
  const parsed: JsonValue = JSON.parse(text)
  return parsed
}

function edgeIndexKey(from: string, when: string): string {
  return `${from}\u0000${when}`
}

/**
 * Walk one graph. The generator yields whenever it needs the world to answer.
 *
 * `depth`, `visitedAgents`, and `definitionPath` describe where this walk sits
 * inside the recursive definition; the run-wide latch and output live on
 * `control` and are deliberately shared with every child walk.
 */
export function* walkGraph(
  graph: WorkflowGraphV1,
  values: Readonly<Record<string, JsonValue>>,
  control: RunControl,
  scope: {
    readonly depth: number
    readonly visitedAgents: ReadonlySet<string>
    readonly prefix: string
    readonly definitionPath: readonly string[]
    readonly typedContext: ExecutionContext
  },
): Generator<ActionRequest, WalkResult, ActionOutcome> {
  const byID = new Map<string, GraphNode>()
  // Last definition wins, exactly as the reference index does. Validation
  // rejects the duplicate; the runtime must still be predictable without it.
  for (const node of graph.nodes) byID.set(node.id, node)
  const edges = new Map<string, string>()
  const edgeRoles = new Map<string, string>()
  const edgeByID = new Map<string, GraphEdge>()
  for (const edge of graph.edges) {
    edges.set(edgeIndexKey(edge.from, edge.when), edge.to)
    edgeRoles.set(edgeIndexKey(edge.from, edge.when), edge.outcome_role ?? "continue")
    edgeByID.set(edge.id, edge)
  }

  const { depth, visitedAgents, prefix, definitionPath, typedContext } = scope
  const context = new Map<string, JsonValue>(Object.entries(values))
  const secretNames = control.secretNames

  const resolveForPrompt = (text: string, ctx: ReadonlyMap<string, JsonValue> = context): string =>
    renderPromptText(text, ctx, secretNames)

  let lastOutput: JsonValue = ""

  const completedResult = (): WalkResult => {
    if (control.latched !== null) {
      return { status: "failed", error: "Workflow completed its failure/reporting path", lastOutput }
    }
    if (depth === 0) control.finalOutput = lastOutput
    return { status: "completed", error: null, lastOutput }
  }

  const route = (nodeKey: string, nodeID: string, when: string, via = "auto"): string | null => {
    const target = edges.get(edgeIndexKey(nodeID, when)) ?? null
    if (target !== null && edgeRoles.get(edgeIndexKey(nodeID, when)) === "failure") {
      latch(control, TerminationReason.ReportedFailure)
    }
    control.events.emit(nodeKey, "edge_taken", { when, to: target, via })
    return target
  }

  let nodeID: string | null = graph.entry
  let stepsTaken = 0
  const maxSteps = graph.settings?.max_graph_steps ?? DEFAULT_MAX_GRAPH_STEPS
  const cyclic = Boolean(graph.settings?.allow_cycles) && Boolean(control.options.flags?.cyclicEdgesEnabled)
  const visits = new Map<string, number>()

  while (nodeID) {
    stepsTaken += 1
    if (stepsTaken > maxSteps) {
      latch(control, TerminationReason.GraphStepLimit)
      return { status: "failed", error: `Graph step limit (${maxSteps}) exceeded`, lastOutput }
    }
    if (cyclic) {
      const seen = (visits.get(nodeID) ?? 0) + 1
      visits.set(nodeID, seen)
      const bound = graph.settings?.max_node_visits || 1
      if (seen > bound) {
        latch(control, TerminationReason.NodeVisitLimit)
        return { status: "failed", error: `Node "${nodeID}" exceeded max_node_visits (${bound})`, lastOutput }
      }
      // The reference emitter keys this one event off the bare id, not the
      // definition key; reproduced so a child's visit rows line up.
      if (seen > 1) control.events.emit(`${prefix}${nodeID}`, "node_visit", { n: seen })
    }
    if (control.runDeadlineMs !== null && control.options.clock.monotonicMs() > control.runDeadlineMs) {
      const timeout = graph.settings?.timeout_sec ?? null
      control.events.emit("", "run_timeout", { timeout_sec: timeout })
      latch(control, TerminationReason.RunTimeout)
      return { status: "failed", error: `Run timeout (${timeout}s) exceeded`, lastOutput }
    }
    const node = byID.get(nodeID)
    if (node === undefined) {
      latch(control, TerminationReason.ContractViolation)
      return { status: "failed", error: `Node "${nodeID}" not found`, lastOutput }
    }
    const current = instanceKey(definitionPath, node.id, [], visits.get(node.id) ?? 1)

    if (node.type === "success" || node.type === "error" || node.type === "output") {
      if (node.type === "output") {
        try {
          let payload: JsonValue = node.output_binding ? typedContext.resolve(node.output_binding, current) : lastOutput
          if (node.output_schema && typeof payload === "string") payload = parseJson(payload)
          lastOutput = validateOutput(payload, node.output_schema, `nodes/${node.id}/output`)
        } catch (error) {
          if (
            !(error instanceof ContractViolation) &&
            !(error instanceof DataResolutionError) &&
            !(error instanceof SyntaxError)
          ) {
            throw error
          }
          latch(control, TerminationReason.OutputSchemaValidationFailed)
          return { status: "failed", error: "Output payload failed schema validation", lastOutput }
        }
        if (depth === 0) {
          control.finalOutput = lastOutput
          control.outputNodeID = node.id
        }
      }
      if (node.type !== "error") return completedResult()
      latch(control, TerminationReason.ReportedFailure)
      return { status: "failed", error: "Run reached the error terminal", lastOutput }
    }

    // Terminals are resolved above, so a cancel racing a terminal loses — the
    // reference runtime makes the same call and the corpus depends on it.
    if (isCancelled(control)) return { status: "cancelled", error: null, lastOutput }

    const nodeKey = definitionPath.length > 0 ? definitionNodeKey(definitionPath, node.id) : `${prefix}${node.id}`
    if (control.options.atSafePoint?.({ nodeKey, nodeId: node.id, definitionPath }) === true) {
      if (isCancelled(control)) return { status: "cancelled", error: null, lastOutput }
    }

    const state = nodeState(control, nodeKey)
    state.status = "running"
    state.startedAt = control.options.clock.monotonicMs()
    const startedMs = state.startedAt
    const hardened = node.type === "agent" ? (node.hardened_steps ?? {}) : {}
    const hasHardenedSteps = isJsonObject(hardened) && Array.isArray(hardened["steps"]) && hardened["steps"].length > 0
    control.events.emit(nodeKey, "node_started", {
      type: node.type,
      name: nodeDisplayName(node),
      definition_path: [...definitionPath],
      mode_hint: hasHardenedSteps ? "replay" : node.type === "agent" || node.type === "loop" ? "agent" : null,
    })

    if (node.type === "condition") {
      const outcome = asCheckOutcome(
        yield {
          kind: "condition",
          nodeKey,
          nodeId: node.id,
          definitionPath,
          visit: current.visit,
          check: node.check,
        },
      )
      control.events.emit(nodeKey, "condition_eval", {
        kind: node.check.kind,
        value: node.check.value,
        result: outcome.passed,
        edge: outcome.passed ? "true" : "false",
      })
      state.status = "completed"
      state.mode = "deterministic"
      state.output = `${node.check.kind}(${pythonRepr(node.check.value)}) → ${outcome.passed ? "True" : "False"} (${outcome.detail})`
      typedContext.publishNode(current, { passed: outcome.passed, kind: node.check.kind, detail: outcome.detail })
      state.finishedAt = control.options.clock.monotonicMs()
      finishNode(control, nodeKey, startedMs)
      nodeID = route(nodeKey, node.id, outcome.passed ? "true" : "false", "condition")
      continue
    }

    if (node.type === "subworkflow") {
      if (depth + 1 >= MAX_SUBWORKFLOW_DEPTH) {
        state.status = "failed"
        state.error = `Subworkflow depth limit (${MAX_SUBWORKFLOW_DEPTH}) reached`
        state.finishedAt = control.options.clock.monotonicMs()
      } else if (visitedAgents.has(node.target_agent_id)) {
        state.status = "failed"
        state.error = "Subworkflow reference cycle detected"
        state.finishedAt = control.options.clock.monotonicMs()
      } else {
        const childPath = [...definitionPath, node.id]
        // Outside the guarded block on purpose: a member that cannot be read is
        // a corrupt definition, not a child failure, and must not be laundered
        // into the node's error edge.
        const member = control.options.resolver.member(childPath)
        control.events.emit(nodeKey, "subworkflow_entered", {
          target_agent_id: node.target_agent_id,
          depth: depth + 1,
          definition_path: [...childPath],
          content_hash: member.graphDigest,
        })
        let childResult: WalkResult = { status: "failed", error: null, lastOutput: "" }
        try {
          const childGraph = control.options.resolver.child(definitionPath, node.id, node.target_agent_id)
          const childValues: Record<string, JsonValue> = {}
          for (const [name, template] of Object.entries(node.input_mapping ?? {})) {
            childValues[name] = resolveForPrompt(template)
          }
          childResult = yield* walkGraph(childGraph, childValues, control, {
            depth: depth + 1,
            visitedAgents: new Set([...visitedAgents, node.target_agent_id]),
            prefix: "",
            definitionPath: childPath,
            typedContext: typedContext.child(childValues),
          })
        } catch (error) {
          // The reference collapses EVERY child exception into one sentence, so
          // an unreadable definition and a broken binding are indistinguishable
          // to the parent. Reproduced deliberately.
          if (!(error instanceof Error)) throw error
          childResult = {
            status: "failed",
            error: "Immutable subworkflow definition is invalid or unavailable",
            lastOutput: "",
          }
        }
        control.events.emit(nodeKey, "subworkflow_exited", {
          target_agent_id: node.target_agent_id,
          status: childResult.status,
          definition_path: [...childPath],
          content_hash: member.graphDigest,
        })
        if (childResult.status === "cancelled") {
          state.status = "cancelled"
          state.finishedAt = control.options.clock.monotonicMs()
          finishNode(control, nodeKey, startedMs)
          return { status: "cancelled", error: null, lastOutput }
        }
        if (childResult.status === "completed") {
          state.status = "completed"
          state.output = childResult.lastOutput
          state.finishedAt = control.options.clock.monotonicMs()
          finishNode(control, nodeKey, startedMs)
          lastOutput = childResult.lastOutput
          typedContext.publishNode(current, childResult.lastOutput)
          context.set("PREV_OUTPUT", childResult.lastOutput)
          context.set(`NODE_${node.id.toUpperCase()}_OUTPUT`, childResult.lastOutput)
          nodeID = route(nodeKey, node.id, "success")
          if (nodeID === null) return completedResult()
          continue
        }
        state.status = "failed"
        state.error = childResult.error ?? "Subworkflow failed"
        state.finishedAt = control.options.clock.monotonicMs()
        latch(control, TerminationReason.DefinitionInvalid)
      }
      finishNode(control, nodeKey, startedMs)
      nodeID = route(nodeKey, node.id, "error")
      if (nodeID === null) return { status: "failed", error: state.error ?? null, lastOutput }
      continue
    }

    if (node.type === "loop") {
      const all = parseItems(context.get(node.items_variable) ?? "")
      const dropped = Math.max(0, all.length - node.max_iterations)
      const items = all.slice(0, node.max_iterations)
      const outputs: JsonValue[] = []
      let failedError: string | null = null
      for (const [index, item] of items.entries()) {
        if (isCancelled(control)) {
          state.status = "cancelled"
          state.finishedAt = control.options.clock.monotonicMs()
          finishNode(control, nodeKey, startedMs)
          return { status: "cancelled", error: null, lastOutput }
        }
        const iterationContext = new Map(context)
        iterationContext.set("ITEM", item)
        iterationContext.set("ITEM_INDEX", index)
        let instruction =
          SCOPED_PREAMBLE +
          `Step: ${node.name} (item ${index + 1}/${items.length})\nInstruction: ` +
          resolveForPrompt(node.item_instruction, iterationContext)
        if (findSecretTokens(instruction).length > 0) instruction = SECRET_PREAMBLE + instruction
        log(control, nodeKey, `item ${index + 1}/${items.length}: ${Array.from(pythonStr(item)).slice(0, 60).join("")}`)
        control.events.emit(nodeKey, "loop_item_started", {
          index,
          total: items.length,
          item_preview: preview(item, 100),
        })
        const outcome = normalizeTaskOutcome(
          asTaskOutcome(
            yield {
              kind: "loop_item",
              nodeKey,
              nodeId: node.id,
              definitionPath,
              visit: current.visit,
              instruction,
              index,
              total: items.length,
              item,
              globalRules: globalRulesFor(control, definitionPath),
            },
          ),
        )
        control.events.emit(nodeKey, "loop_item_finished", {
          index,
          total: items.length,
          item_preview: preview(item, 100),
          status: outcome.status,
          output_preview: preview(outcome.output),
        })
        if (outcome.status === "cancelled" || isCancelled(control)) {
          state.status = "cancelled"
          state.finishedAt = control.options.clock.monotonicMs()
          finishNode(control, nodeKey, startedMs)
          return { status: "cancelled", error: null, lastOutput }
        }
        if (outcome.status !== "completed") {
          failedError = `item ${index + 1} failed: ${outcome.error ?? "task failed"}`
          break
        }
        outputs.push(orEmpty(outcome.output))
        state.output = pythonJson(outputs)
      }
      if (failedError === null) {
        if (dropped > 0) log(control, nodeKey, `${dropped} item(s) beyond max_iterations were skipped`)
        const payload = pythonJson(outputs)
        state.status = "completed"
        state.mode = "agent"
        state.output = payload
        state.finishedAt = control.options.clock.monotonicMs()
        finishNode(control, nodeKey, startedMs)
        // The typed publication is the LIST; the template context gets the
        // JSON string. The reference runtime makes the same split.
        lastOutput = outputs
        typedContext.publishNode(current, outputs)
        context.set("PREV_OUTPUT", payload)
        context.set(`NODE_${node.id.toUpperCase()}_OUTPUT`, payload)
        nodeID = route(nodeKey, node.id, "success")
        if (nodeID === null) return completedResult()
      } else {
        state.status = "failed"
        state.error = failedError
        state.finishedAt = control.options.clock.monotonicMs()
        latch(control, TerminationReason.ReportedFailure)
        finishNode(control, nodeKey, startedMs)
        nodeID = route(nodeKey, node.id, "error")
        if (nodeID === null) return { status: "failed", error: failedError, lastOutput }
      }
      continue
    }

    // ---------------- agent ----------------
    // Unreachable for a compiled program: an unknown node type is refused at
    // authoring. Raising here mirrors the reference runtime, whose attribute
    // access on an unknown node throws into the run-level handler.
    if (node.type !== "agent") throw new ContractViolation("UNKNOWN_NODE_TYPE", `nodes/${node.id}`)

    let narrowedInputs: Readonly<Record<string, JsonValue>> | null = null
    try {
      narrowedInputs =
        node.input_schema === null || node.input_schema === undefined
          ? null
          : resolveNodeInputs(node.input_schema, typedContext, { current, location: `nodes/${node.id}/input` })
      if (control.options.resolveModel && !control.options.resolveModel(node.model ?? null)) {
        throw new ContractViolation("MODEL_UNRESOLVABLE", `nodes/${node.id}/model`)
      }
    } catch (error) {
      if (!(error instanceof KernelError)) throw error
      latch(control, TerminationReason.ContractViolation)
      state.status = "failed"
      state.error = "Node runtime contract could not be resolved"
      state.finishedAt = control.options.clock.monotonicMs()
      finishNode(control, nodeKey, startedMs)
      // No error edge is consulted: an unsatisfiable contract ends the run.
      return { status: "failed", error: state.error, lastOutput }
    }

    const instructionResolved = resolveForPrompt(node.instruction)
    // The gate hashes the AUTHORED instruction, not the rendered one, so a
    // capture survives a variable value changing between runs.
    const ihash = instructionHash(node.instruction)
    const hardenedSteps = isJsonObject(hardened) && Array.isArray(hardened["steps"]) ? hardened["steps"] : []
    const replayable =
      hasHardenedSteps && isJsonObject(hardened) && hardened["instruction_hash"] === ihash && !wiredScript(node)
    const outEdges = graph.edges.filter((edge) => edge.from === node.id)

    if (outEdges.some((edge) => edge.when === "ai" || edge.when === "selector")) {
      if (control.options.flags?.nodeLoopEnabled !== true) {
        // Fail loudly: the classic router would find no success edge and end
        // the run "completed", which is worse than an explicit refusal.
        state.status = "failed"
        state.error = "Node has ai/selector transition edges but NODE_LOOP_ENABLED is off"
        state.finishedAt = control.options.clock.monotonicMs()
        finishNode(control, nodeKey, startedMs)
        return { status: "failed", error: state.error, lastOutput }
      }
      if (replayable) {
        // Context only: the edge choice always stays with the transition.
        yield* replaySteps(control, node, nodeKey, definitionPath, current.visit, hardenedSteps, ihash, true)
      }
      let instruction = SCOPED_PREAMBLE + `Step: ${node.name}\nInstruction: ` + instructionResolved
      if (findSecretTokens(instruction).length > 0) instruction = SECRET_PREAMBLE + instruction
      const raw = asTaskOutcome(
        yield {
          kind: "transition",
          nodeKey,
          nodeId: node.id,
          definitionPath,
          visit: current.visit,
          instruction,
          narrowedInputs,
          model: node.model ?? null,
          edges: outEdges,
          globalRules: globalRulesFor(control, definitionPath),
        },
      )
      const outcome = normalizeTaskOutcome(raw)
      if (outcome.status === "cancelled" || isCancelled(control)) {
        state.status = "cancelled"
        state.finishedAt = control.options.clock.monotonicMs()
        finishNode(control, nodeKey, startedMs, { tokens: outcome.tokens })
        return { status: "cancelled", error: null, lastOutput }
      }
      const choice = raw.edge ?? null
      if (choice === null) {
        latch(control, outcome.terminationReason)
        state.status = "failed"
        state.error = outcome.error ?? "Node ended without choosing a transition"
        state.finishedAt = control.options.clock.monotonicMs()
        finishNode(control, nodeKey, startedMs, { tokens: outcome.tokens })
        return { status: "failed", error: state.error, lastOutput }
      }
      const contract = outEdges.find((edge) => edge.id === choice.edgeId)
      const tookFailurePath =
        outcome.status === "failed" ||
        outcome.terminationReason !== TerminationReason.Done ||
        (contract !== undefined && contract.outcome_role === "failure")
      if (tookFailurePath) {
        latch(control, outcome.terminationReason)
        state.status = "failed"
        state.error = outcome.error ?? "Node took the failure path"
        state.finishedAt = control.options.clock.monotonicMs()
      } else {
        state.status = "completed"
        state.mode = "agent"
        state.output = outcome.output
        state.finishedAt = control.options.clock.monotonicMs()
      }
      finishNode(control, nodeKey, startedMs, { tokens: outcome.tokens })
      if (!tookFailurePath) {
        lastOutput = orEmpty(outcome.output)
        typedContext.publishNode(current, lastOutput)
        context.set("PREV_OUTPUT", lastOutput)
        context.set(`NODE_${node.id.toUpperCase()}_OUTPUT`, lastOutput)
      }
      control.events.emit(nodeKey, "edge_taken", {
        when: "transition",
        to: choice.to,
        via: choice.via,
        edge_id: choice.edgeId,
      })
      // Published even on the failure path: the payload is evidence the
      // transition happened, independent of whether the node succeeded.
      typedContext.publishEdge(
        edgeKey(definitionPath, choice.edgeId, [], visits.get(node.id) ?? 1),
        choice.payload ?? null,
      )
      nodeID = choice.to
      continue
    }

    if (replayable) {
      const replay = yield* replaySteps(
        control,
        node,
        nodeKey,
        definitionPath,
        current.visit,
        hardenedSteps,
        ihash,
        false,
      )
      if (replay.ok) {
        const verdict = yield* verifyOutcome(control, node, nodeKey, definitionPath, current.visit)
        if (verdict.passed) {
          state.status = "completed"
          state.mode = "deterministic"
          state.output = replay.detail
          state.finishedAt = control.options.clock.monotonicMs()
          finishNode(control, nodeKey, startedMs)
          lastOutput = replay.detail
          typedContext.publishNode(current, replay.detail)
          context.set("PREV_OUTPUT", replay.detail)
          context.set(`NODE_${node.id.toUpperCase()}_OUTPUT`, replay.detail)
          nodeID = route(nodeKey, node.id, "success")
          if (nodeID === null) return completedResult()
          continue
        }
        log(control, nodeKey, "replay outcome check failed — falling back to the agent")
      } else {
        log(control, nodeKey, `hardened replay failed (${replay.detail}) — falling back to the agent`)
      }
    }

    let instruction = SCOPED_PREAMBLE + `Step: ${node.name}\nInstruction: ` + instructionResolved
    if (narrowedInputs !== null) {
      instruction +=
        "\n\nInputs for this step (typed, narrowed by input-schema):\n" +
        pythonJson(narrowedInputs, { compact: true, ensureAscii: false })
    }
    if (findSecretTokens(instruction).length > 0) instruction = SECRET_PREAMBLE + instruction

    const raw = asTaskOutcome(
      yield {
        kind: "agent",
        nodeKey,
        nodeId: node.id,
        definitionPath,
        visit: current.visit,
        instruction,
        narrowedInputs,
        model: node.model ?? null,
        capabilities: node.capabilities ?? null,
        globalRules: globalRulesFor(control, definitionPath),
      },
    )
    const outcome = normalizeTaskOutcome(raw)

    if (outcome.status === "cancelled" || isCancelled(control)) {
      state.status = "cancelled"
      state.finishedAt = control.options.clock.monotonicMs()
      // A cancelled pass produced no verdict, so the key is absent rather
      // than null: "we do not know" and "it never finished" are different.
      finishNode(control, nodeKey, startedMs, { tokens: outcome.tokens })
      return { status: "cancelled", error: null, lastOutput }
    }

    if (outcome.status === "completed") {
      const verdict = yield* verifyOutcome(control, node, nodeKey, definitionPath, current.visit)
      if (verdict.passed) {
        state.status = "completed"
        state.mode = "agent"
        state.output = outcome.output
        state.finishedAt = control.options.clock.monotonicMs()
        finishNode(control, nodeKey, startedMs, agentVerdict(outcome))
        const output = orEmpty(outcome.output)
        lastOutput = output
        typedContext.publishNode(current, output)
        context.set("PREV_OUTPUT", output)
        context.set(`NODE_${node.id.toUpperCase()}_OUTPUT`, output)
        nodeID = route(nodeKey, node.id, "success")
        if (nodeID === null) return completedResult()
      } else {
        state.status = "failed"
        state.error = `Expected outcome not met: ${verdict.detail}`
        state.finishedAt = control.options.clock.monotonicMs()
        latch(control, TerminationReason.OutputSchemaValidationFailed)
        finishNode(control, nodeKey, startedMs, agentVerdict(outcome))
        nodeID = route(nodeKey, node.id, "error")
        if (nodeID === null) return { status: "failed", error: state.error, lastOutput }
      }
    } else {
      state.status = "failed"
      state.error = outcome.error ?? "Task failed"
      state.finishedAt = control.options.clock.monotonicMs()
      latch(control, outcome.terminationReason)
      finishNode(control, nodeKey, startedMs, agentVerdict(outcome))
      nodeID = route(nodeKey, node.id, "error")
      if (nodeID === null) return { status: "failed", error: state.error, lastOutput }
    }
  }

  return completedResult()
}

/** A classic agent pass always reports a verdict, even when it is "unknown". */
function agentVerdict(outcome: ReturnType<typeof normalizeTaskOutcome>): {
  readonly tokens: number | null
  readonly verdict: { readonly value: boolean | null }
} {
  return { tokens: outcome.tokens, verdict: { value: outcome.isSuccessful ?? null } }
}

/**
 * A node with an authored script has a deterministic form of its own, so a
 * hardened capture must not shadow it. The kernel does not run scripts (that is
 * the browser substrate's job), but it must still honour the precedence.
 */
function wiredScript(node: Extract<GraphNode, { type: "agent" }>): boolean {
  return Boolean(node.script?.filepath)
}

/** Ask the host to replay the captured steps, and mirror each into the stream. */
function* replaySteps(
  control: RunControl,
  node: Extract<GraphNode, { type: "agent" }>,
  nodeKey: string,
  definitionPath: readonly string[],
  visit: number,
  steps: readonly JsonValue[],
  hash: string,
  transition: boolean,
): Generator<ActionRequest, ReplayOutcome, ActionOutcome> {
  const outcome = asReplayOutcome(
    yield {
      kind: "replay",
      nodeKey,
      nodeId: node.id,
      definitionPath,
      visit,
      steps,
      instructionHash: hash,
      transition,
    },
  )
  for (const step of outcome.steps ?? []) {
    control.events.emit(nodeKey, "replay_step", {
      n: step.n,
      action: step.action,
      ok: step.ok,
      detail: step.detail ?? null,
    })
  }
  return outcome
}

/** Terminals carry no name, so they report their kind. */
function nodeDisplayName(node: GraphNode): string {
  return "name" in node ? node.name : node.type
}

function globalRulesFor(control: RunControl, definitionPath: readonly string[]): string | null {
  const rules = control.options.resolver.globalRules(definitionPath)
  const trimmed = rules.trim().slice(0, 8000)
  return trimmed.length > 0 ? trimmed : null
}

/** A plain-string `expected_outcome` is documentation; only a structured one is checked. */
function* verifyOutcome(
  control: RunControl,
  node: Extract<GraphNode, { type: "agent" }>,
  nodeKey: string,
  definitionPath: readonly string[],
  visit: number,
): Generator<ActionRequest, CheckOutcome, ActionOutcome> {
  const expected = node.expected_outcome
  if (expected === null || expected === undefined || typeof expected === "string") {
    return { passed: true, detail: "" }
  }
  if (expected.kind === "ai_judge" && control.secretNames.size > 0) {
    return { passed: false, detail: "AI page judging is disabled for secret-bearing runs" }
  }
  const outcome = asCheckOutcome(
    yield {
      kind: "verification",
      nodeKey,
      nodeId: node.id,
      definitionPath,
      visit,
      check: expected,
    },
  )
  control.events.emit(nodeKey, "verification", {
    kind: expected.kind,
    value: expected.value,
    passed: outcome.passed,
    detail: outcome.detail,
  })
  return outcome
}

/**
 * Drive a whole run: `run_started`, the walk, then `run_finished`.
 *
 * The generator is exposed rather than hidden so an asynchronous host can drive
 * the identical state machine without the kernel ever learning about promises.
 */
export function* runWorkflowGraph(options: RunOptions): Generator<ActionRequest, RunResult, ActionOutcome> {
  const graph = options.resolver.root()
  const runInput = options.runInput ?? {}
  const declaredSecrets = (graph.variables ?? []).filter((variable) => variable.secret).map((variable) => variable.name)
  const control: RunControl = {
    latched: null,
    finalOutput: null,
    outputNodeID: null,
    runDeadlineMs: null,
    events: new DecisionEventLog(options.runID, options.clock, options.attemptID ?? null),
    nodeStates: new Map(),
    options,
    secretNames: new Set([...declaredSecrets, ...(options.secretNames ?? [])]),
    cancelled: false,
  }
  const startedMs = options.clock.monotonicMs()
  control.events.emit("", "run_started", {
    graph_name: graph.name,
    node_count: graph.nodes.length,
    variables: (graph.variables ?? []).map((variable) => variable.name),
  })
  if (options.flags?.nodeLoopTimeoutsEnabled === true && graph.settings?.timeout_sec) {
    control.runDeadlineMs = startedMs + graph.settings.timeout_sec * 1000
  }

  let result: WalkResult
  try {
    result = yield* walkGraph(graph, runInput, control, {
      depth: 0,
      visitedAgents: new Set([options.rootAgentID]),
      prefix: "",
      definitionPath: [],
      typedContext: ExecutionContext.create(runInput),
    })
  } catch {
    control.latched = control.latched ?? TerminationReason.Exception
    result = { status: "failed", error: "Workflow execution failed", lastOutput: null }
  }

  const terminationReason = runTerminationReason(result.status, control.latched)
  const outcomeLabel = outcomeLabelFor(result.status, terminationReason)
  control.events.emit("", "run_finished", {
    status: result.status,
    termination_reason: terminationReason,
    outcome_label: outcomeLabel,
    error: preview(result.error),
    duration_ms: Math.trunc(options.clock.monotonicMs() - startedMs),
  })
  return {
    status: result.status,
    terminationReason,
    outcomeLabel,
    error: result.error,
    output: result.status === "completed" ? control.finalOutput : null,
    outputNodeID: result.status === "completed" ? control.outputNodeID : null,
    events: control.events.events,
    nodeStates: Object.fromEntries(control.nodeStates),
  }
}

/** Drive the kernel synchronously with a total action port. */
export function runWorkflow(options: RunOptions, port: ActionPort): RunResult {
  const machine = runWorkflowGraph(options)
  let step = machine.next()
  while (!step.done) {
    step = machine.next(answer(port, step.value))
  }
  return step.value
}
