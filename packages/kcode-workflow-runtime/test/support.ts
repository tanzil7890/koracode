/**
 * Test helpers.
 *
 * Everything here is in-memory: graphs are literals, bundles are built from
 * them, and the action port is a script. No test in this package opens a file,
 * a socket, a process, or a database.
 */
import type { JsonValue, RunEventV1 } from "@koracode/kcode-workflow-contracts"
import {
  asString,
  assetManifest,
  compile,
  contentDigest,
  definitionBundle,
  fixedClock,
  runWorkflow,
  type ActionPort,
  type AgentRequest,
  type CheckOutcome,
  type CompiledProgram,
  type ConditionRequest,
  type DefinitionMember,
  type LoopItemRequest,
  type ReplayOutcome,
  type ReplayRequest,
  type RunOptions,
  type RunResult,
  type TaskOutcome,
  type TransitionOutcome,
  type TransitionRequest,
  type VerificationRequest,
} from "../src"

export type GraphDoc = Readonly<Record<string, JsonValue>>

export function position(index: number): JsonValue {
  return { x: index * 220, y: 0 }
}

export function terminals(start: number): readonly JsonValue[] {
  return [
    { id: "ok", type: "success", position: position(start) },
    { id: "bad", type: "error", position: position(start + 1) },
  ]
}

export function member(path: readonly string[], agentID: string, graph: GraphDoc, globalRules = ""): DefinitionMember {
  return {
    path,
    agentId: agentID,
    graph,
    globalRules,
    graphDigest: contentDigest(graph),
    assets: assetManifest(graph),
  }
}

export function programOf(graph: GraphDoc, options: { readonly cyclicEdgesEnabled?: boolean } = {}): CompiledProgram {
  return compile(definitionBundle("root-agent", [member([], "root-agent", graph)]), options)
}

export function programWithChild(
  parent: GraphDoc,
  childNodeID: string,
  childAgentID: string,
  child: GraphDoc,
  options: { readonly cyclicEdgesEnabled?: boolean } = {},
): CompiledProgram {
  return compile(
    definitionBundle("root-agent", [member([], "root-agent", parent), member([childNodeID], childAgentID, child)]),
    options,
  )
}

export type PortOverrides = {
  readonly condition?: (request: ConditionRequest) => CheckOutcome
  readonly verification?: (request: VerificationRequest) => CheckOutcome
  readonly agent?: (request: AgentRequest) => TaskOutcome
  readonly loopItem?: (request: LoopItemRequest) => TaskOutcome
  readonly transition?: (request: TransitionRequest) => TransitionOutcome
  readonly replay?: (request: ReplayRequest) => ReplayOutcome
}

/** A port that succeeds at everything unless a case says otherwise. */
export function port(overrides: PortOverrides = {}): ActionPort {
  return {
    condition: overrides.condition ?? (() => ({ passed: true, detail: "ok" })),
    verification: overrides.verification ?? (() => ({ passed: true, detail: "" })),
    agent:
      overrides.agent ??
      ((request) => ({ status: "completed", output: `${request.nodeId} output`, isSuccessful: true })),
    loopItem:
      overrides.loopItem ??
      ((request) => ({ status: "completed", output: `item ${request.index}`, isSuccessful: true })),
    transition:
      overrides.transition ??
      ((request) => {
        const edge = request.edges[0]
        if (edge === undefined) return { status: "failed", error: "no edge" }
        return { status: "completed", output: "", edge: { edgeId: edge.id, to: edge.to, via: "handoff" } }
      }),
    replay: overrides.replay ?? (() => ({ ok: true, detail: "replayed" })),
  }
}

export function runOptions(program: CompiledProgram, extra: Partial<RunOptions> = {}): RunOptions {
  return {
    runID: "run-1",
    resolver: program.resolver,
    rootAgentID: program.rootAgentID,
    clock: fixedClock(),
    ...extra,
  }
}

export function run(
  program: CompiledProgram,
  actions: ActionPort = port(),
  extra: Partial<RunOptions> = {},
): RunResult {
  return runWorkflow(runOptions(program, extra), actions)
}

export function kinds(events: readonly RunEventV1[]): readonly string[] {
  return events.map((event) => event.kind)
}

export function edgesTaken(events: readonly RunEventV1[]): readonly (readonly [string, JsonValue])[] {
  return events
    .filter((event) => event.kind === "edge_taken")
    .map((event) => [asString(event.payload["when"]), event.payload["to"] ?? null] as const)
}

export function nodePath(events: readonly RunEventV1[]): readonly string[] {
  return events.filter((event) => event.kind === "node_started").map((event) => event.node_key)
}
