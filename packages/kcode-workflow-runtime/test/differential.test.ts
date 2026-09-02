/**
 * The differential: every recorded vector, replayed through the candidate.
 *
 * The vectors were produced by the shipped Python walker under the same script
 * this port answers from, so a difference here is a difference in semantics,
 * not in fixtures. Durations are the only field excluded, because they measure
 * the machine the run happened on.
 */
import { describe, expect, test } from "bun:test"
import vectorDocument from "../vectors/deterministic-vectors.v1.json" with { type: "json" }
import type { JsonValue, RunEventV1 } from "@koracode/kcode-workflow-contracts"
import { validateEventOrder } from "@koracode/kcode-workflow-contracts"
import {
  assetManifest,
  compile,
  contentDigest,
  definitionBundle,
  fixedClock,
  runWorkflowGraph,
  type ActionOutcome,
  type ActionRequest,
  type DefinitionMember,
  type NodeState,
  type RunResult,
} from "../src"
import { ScriptedPort, type Recorded, type ScriptDoc } from "./script"

type MemberDoc = {
  readonly path: readonly string[]
  readonly agent_id: string
  readonly graph: Readonly<Record<string, JsonValue>>
  readonly global_rules: string
  readonly graph_digest: string
  readonly assets: readonly { node_id: string; path: string; digest: string; bytes: number }[]
}

type Expected = {
  readonly status: string
  readonly termination_reason: string
  readonly outcome_label: string
  readonly error: string | null
  readonly output: JsonValue
  readonly output_node_id: string | null
  readonly events: readonly { sequence: number; kind: string; node_key: string; payload: Record<string, JsonValue> }[]
  readonly node_states: Readonly<Record<string, Record<string, JsonValue>>>
  readonly instructions: readonly Recorded[]
}

type Vector = {
  readonly id: string
  readonly case_id: string
  readonly source: string
  readonly classes: readonly string[]
  readonly note: string
  readonly flags: Readonly<Record<string, boolean>>
  readonly definition: string
  readonly run_input: Readonly<Record<string, JsonValue>>
  readonly script: ScriptDoc
  readonly expected: Expected
}

type VectorDocument = {
  readonly kind: string
  readonly schema_version: string
  readonly protocol_version: string
  readonly corpus_version: string
  readonly corpus_digest: string
  readonly reference_engine: { engine: string; engine_version: string }
  readonly skipped_cases: readonly { case_id: string; reason: string }[]
  readonly definitions: Readonly<
    Record<string, { root_agent_id: string; digest: string; members: readonly MemberDoc[] }>
  >
  readonly vectors: readonly Vector[]
}

const document = vectorDocument as unknown as VectorDocument

function memberOf(doc: MemberDoc): DefinitionMember {
  return {
    path: doc.path,
    agentId: doc.agent_id,
    graph: doc.graph,
    globalRules: doc.global_rules,
    graphDigest: doc.graph_digest,
    assets: doc.assets,
  }
}

function normalizeEvents(events: readonly RunEventV1[]) {
  return events.map((event) => ({
    sequence: event.sequence,
    kind: event.kind,
    node_key: event.node_key,
    payload: withoutDuration(event.payload),
  }))
}

function normalizeExpectedEvents(events: Expected["events"]) {
  return events.map((event) => ({
    sequence: event.sequence,
    kind: event.kind,
    node_key: event.node_key,
    payload: withoutDuration(event.payload),
  }))
}

/** A duration measures the machine, never the decision. */
function withoutDuration(payload: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const copy: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (key !== "duration_ms") copy[key] = value
  }
  return copy
}

type FlatState = Readonly<Record<string, JsonValue>>

function normalizeStates(states: Readonly<Record<string, NodeState>>): Record<string, FlatState> {
  return Object.fromEntries(
    Object.entries(states).map(([key, state]) => [
      key,
      {
        status: state.status,
        mode: state.mode ?? null,
        output: state.output ?? null,
        error: state.error ?? null,
        logs: state.logs.map((line) => line.message),
      },
    ]),
  )
}

function normalizeExpectedStates(states: Expected["node_states"]): Record<string, FlatState> {
  return Object.fromEntries(
    Object.entries(states).map(([key, state]) => [
      key,
      {
        status: state["status"] ?? null,
        mode: state["mode"] ?? null,
        output: state["output"] ?? null,
        error: state["error"] ?? null,
        logs: state["logs"] ?? [],
      },
    ]),
  )
}

function execute(vector: Vector): { readonly result: RunResult; readonly instructions: readonly Recorded[] } {
  const definition = document.definitions[vector.definition]
  if (definition === undefined) throw new Error(`vector ${vector.id} names an absent definition`)
  const bundle = {
    rootAgentId: definition.root_agent_id,
    digest: definition.digest,
    members: definition.members.map(memberOf),
  }
  const program = compile(bundle, { cyclicEdgesEnabled: vector.flags["cyclic_edges_enabled"] })
  const port = new ScriptedPort(vector.script)
  const machine = runWorkflowGraph({
    runID: "phase-12-10-vector-run",
    resolver: program.resolver,
    rootAgentID: program.rootAgentID,
    runInput: vector.run_input,
    clock: fixedClock(),
    flags: {
      nodeLoopEnabled: vector.flags["node_loop_enabled"],
      nodeLoopTimeoutsEnabled: vector.flags["node_loop_timeouts_enabled"],
      cyclicEdgesEnabled: vector.flags["cyclic_edges_enabled"],
    },
  })
  let step = machine.next()
  while (!step.done) {
    const request: ActionRequest = step.value
    let outcome: ActionOutcome
    switch (request.kind) {
      case "condition":
        outcome = port.condition(request)
        break
      case "verification":
        outcome = port.verification(request)
        break
      case "agent":
        outcome = port.agent(request)
        break
      case "loop_item":
        outcome = port.loopItem(request)
        break
      case "transition":
        outcome = port.transition(request)
        break
      case "replay":
        outcome = port.replay(request)
        break
    }
    step = machine.next(outcome)
  }
  return { result: step.value, instructions: port.instructions }
}

describe("the vector document", () => {
  test("is the Phase 12.9 corpus, cited by version and digest", () => {
    expect(document.kind).toBe("phase-12-10-deterministic-vectors")
    expect(document.protocol_version).toBe("v1")
    expect(document.corpus_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(document.corpus_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(document.reference_engine.engine).toBe("python")
  })

  test("says why every case it could not diff was left out", () => {
    expect(document.skipped_cases.length).toBeGreaterThan(0)
    document.skipped_cases.forEach((skipped) => {
      expect(skipped.reason.length).toBeGreaterThan(10)
    })
  })

  test("carries enough vectors to be worth calling a differential", () => {
    expect(document.vectors.length).toBeGreaterThanOrEqual(150)
    expect(new Set(document.vectors.map((vector) => vector.id)).size).toBe(document.vectors.length)
    expect(document.vectors.some((vector) => vector.source === "corpus")).toBeTrue()
    expect(document.vectors.some((vector) => vector.source === "kernel")).toBeTrue()
  })

  test("reaches every terminal reason a deterministic run can reach", () => {
    const reasons = new Set(document.vectors.map((vector) => vector.expected.termination_reason))
    expect(reasons).toContain("done")
    expect(reasons).toContain("reported_failure")
    expect(reasons).toContain("cancelled")
    expect(reasons).toContain("contract_violation")
    expect(reasons).toContain("output_schema_validation_failed")
    expect(reasons).toContain("graph_step_limit")
    expect(reasons).toContain("node_visit_limit")
    expect(reasons).toContain("no_handoff")
    expect(reasons).toContain("definition_invalid")
    expect(reasons).toContain("exception")
  })

  test("recomputes every member digest from its own bytes", () => {
    Object.values(document.definitions).forEach((definition) => {
      definition.members.forEach((member) => {
        expect(contentDigest(member.graph)).toBe(member.graph_digest)
        expect(assetManifest(member.graph)).toEqual(member.assets)
      })
      // Recomputing the bundle digest from the members proves the candidate's
      // RFC 8785 canonicalization and member ordering match the reference.
      expect(definitionBundle(definition.root_agent_id, definition.members.map(memberOf)).digest).toBe(
        definition.digest,
      )
    })
  })
})

describe("differential parity with the reference engine", () => {
  document.vectors.forEach((vector) => {
    test(`${vector.id} — ${vector.note}`, () => {
      const { result, instructions } = execute(vector)

      expect(result.status).toBe(vector.expected.status as RunResult["status"])
      expect(result.terminationReason).toBe(vector.expected.termination_reason as RunResult["terminationReason"])
      expect(result.outcomeLabel).toBe(vector.expected.outcome_label as RunResult["outcomeLabel"])
      expect(result.error).toEqual(vector.expected.error)
      expect(result.output).toEqual(vector.expected.output)
      expect(result.outputNodeID).toEqual(vector.expected.output_node_id)
      expect(normalizeEvents(result.events)).toEqual(normalizeExpectedEvents(vector.expected.events))
      expect(normalizeStates(result.nodeStates)).toEqual(normalizeExpectedStates(vector.expected.node_states))
      expect(instructions).toEqual(vector.expected.instructions)
    })
  })
})

describe("the candidate's own stream invariants", () => {
  document.vectors.forEach((vector) => {
    test(`${vector.id} emits a well-ordered stream`, () => {
      const { result } = execute(vector)
      expect(() => validateEventOrder(result.events)).not.toThrow()
    })
  })

  test("the same input and history produce the same decision stream twice", () => {
    document.vectors.forEach((vector) => {
      const first = execute(vector)
      const second = execute(vector)
      expect(normalizeEvents(second.result.events)).toEqual(normalizeEvents(first.result.events))
      expect(second.result.terminationReason).toBe(first.result.terminationReason)
    })
  })
})
