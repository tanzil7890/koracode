/**
 * Property, fuzz, and metamorphic tests.
 *
 * The differential proves the kernel agrees with the reference on the graphs
 * someone thought to write down. These prove the things that must hold for
 * graphs nobody wrote down: that it never runs a node the definition does not
 * contain, never traverses without bound, always reaches exactly one terminal,
 * never contradicts itself about what that terminal was, and always decides the
 * same way twice.
 *
 * Randomness is seeded and pure, so a failure names a seed a reader can replay.
 */
import { describe, expect, test } from "bun:test"
import { validateEventOrder } from "@koracode/kcode-workflow-contracts"
import type { JsonValue, RunEventV1 } from "@koracode/kcode-workflow-contracts"
import {
  CompileError,
  ContractViolation,
  DataResolutionError,
  DefinitionError,
  KernelError,
  TerminationReason,
  acceptsGraph,
  asString,
  compile,
  contentDigest,
  definitionBundle,
  fixedClock,
  isJsonObject,
  parseDataSource,
  parseItems,
  resolveJsonPointer,
  runWorkflow,
  validateInstance,
  validateSchemaDocument,
  validateTerminalPair,
  type ActionPort,
  type RunResult,
} from "../src"
import { member, port } from "./support"
import type { GraphDoc } from "./support"

/** A tiny, pure, seeded generator: the same seed always yields the same graph. */
class Random {
  #state: number
  constructor(seed: number) {
    this.#state = seed >>> 0 || 1
  }
  next(): number {
    // xorshift32: small, well understood, and entirely deterministic.
    let x = this.#state
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.#state = x >>> 0
    return this.#state / 0x100000000
  }
  int(bound: number): number {
    return Math.floor(this.next() * bound)
  }
  pick<T>(items: readonly T[]): T {
    const chosen = items[this.int(items.length)]
    if (chosen === undefined) throw new Error("cannot pick from an empty list")
    return chosen
  }
  bool(): boolean {
    return this.next() < 0.5
  }
}

const seeds = Array.from({ length: 120 }, (_, index) => index * 2654435761 + 1)

function position(index: number): JsonValue {
  return { x: index * 220, y: 0 }
}

/** Random topologies over the node kinds the kernel decides between. */
function randomGraph(random: Random): GraphDoc {
  const taskCount = 1 + random.int(4)
  const nodes: Record<string, JsonValue>[] = []
  const edges: Record<string, JsonValue>[] = []
  const ids: string[] = []

  for (let index = 0; index < taskCount; index += 1) {
    const id = `n${index}`
    ids.push(id)
    const kind = index === 0 ? random.pick(["agent", "loop"]) : random.pick(["agent", "agent", "loop", "condition"])
    if (kind === "loop") {
      nodes.push({
        id,
        type: "loop",
        name: `Loop ${index}`,
        items_variable: "ROWS",
        item_instruction: "Handle {{.ITEM}}.",
        max_iterations: 1 + random.int(3),
        position: position(index),
      })
    } else if (kind === "condition") {
      nodes.push({
        id,
        type: "condition",
        name: `Check ${index}`,
        check: { kind: random.pick(["url_contains", "text_present", "element_exists"]), value: `v${index}` },
        position: position(index),
      })
    } else {
      const node: Record<string, JsonValue> = {
        id,
        type: "agent",
        name: `Agent ${index}`,
        instruction: `Do step ${index}.`,
        position: position(index),
      }
      if (random.bool()) node["expected_outcome"] = { kind: "text_present", value: `done ${index}` }
      nodes.push(node)
    }
  }
  nodes.push({ id: "ok", type: "success", position: position(taskCount) })
  nodes.push({ id: "bad", type: "error", position: position(taskCount + 1) })

  nodes.forEach((node, index) => {
    const id = asString(node["id"])
    if (node["type"] === "success" || node["type"] === "error") return
    const next = ids[index + 1] ?? "ok"
    if (node["type"] === "condition") {
      edges.push({ id: `${id}_t`, from: id, to: next, when: "true" })
      edges.push({ id: `${id}_f`, from: id, to: "bad", when: "false" })
      return
    }
    edges.push({ id: `${id}_s`, from: id, to: next, when: "success" })
    if (random.bool()) {
      edges.push({
        id: `${id}_e`,
        from: id,
        to: "bad",
        when: "error",
        ...(random.bool() ? { outcome_role: "failure" } : {}),
      })
    }
  })

  return {
    version: 3,
    name: "generated",
    entry: ids[0] ?? "n0",
    variables: [{ name: "ROWS" }],
    nodes,
    edges,
    ...(random.bool() ? { settings: { max_graph_steps: 1 + random.int(8) } } : {}),
  } as GraphDoc
}

/** A port whose every answer is decided by the seed, not by chance at run time. */
function randomPort(random: Random): ActionPort {
  return {
    condition: () => ({ passed: random.bool(), detail: "generated" }),
    verification: () => ({ passed: random.next() < 0.8, detail: "generated" }),
    agent: (request) =>
      random.next() < 0.75
        ? { status: "completed", output: `${request.nodeId} output`, isSuccessful: true }
        : { status: "failed", error: "generated failure", isSuccessful: false },
    loopItem: (request) =>
      random.next() < 0.8
        ? { status: "completed", output: `item ${request.index}`, isSuccessful: true }
        : { status: "failed", error: "generated item failure" },
    transition: (request) => {
      const edge = request.edges[0]
      if (edge === undefined) return { status: "failed", error: "no edge", edge: null }
      return { status: "completed", output: "", edge: { edgeId: edge.id, to: edge.to, via: "handoff" } }
    },
    replay: () => ({ ok: random.bool(), detail: "generated replay" }),
  }
}

function generated(seed: number): { graph: GraphDoc; result: RunResult } | null {
  const graph = randomGraph(new Random(seed))
  if (!acceptsGraph(graph)) return null
  const program = compile(definitionBundle("root", [member([], "root", graph)]))
  const result = runWorkflow(
    {
      runID: `seed-${seed}`,
      resolver: program.resolver,
      rootAgentID: program.rootAgentID,
      runInput: { ROWS: ["a", "b", "c"] },
      clock: fixedClock(),
    },
    randomPort(new Random(seed ^ 0x5f3759df)),
  )
  return { graph, result }
}

function nodeIDs(graph: GraphDoc): ReadonlySet<string> {
  const nodes = graph["nodes"]
  return new Set(
    (Array.isArray(nodes) ? nodes : []).flatMap((node) =>
      isJsonObject(node) && typeof node["id"] === "string" ? [node["id"]] : [],
    ),
  )
}

describe("invariants that must hold for any graph the kernel accepts", () => {
  const runs = seeds.map((seed) => ({ seed, generated: generated(seed) })).filter((entry) => entry.generated !== null)

  test("the generator actually produces accepted graphs to reason about", () => {
    expect(runs.length).toBeGreaterThanOrEqual(40)
  })

  test("no node outside the definition is ever executed", () => {
    runs.forEach(({ seed, generated: run }) => {
      if (run === null) return
      const declared = nodeIDs(run.graph)
      run.result.events
        .filter((event) => event.kind === "node_started")
        .forEach((event) => {
          expect(declared.has(event.node_key), `seed ${seed} started ${event.node_key}`).toBeTrue()
        })
    })
  })

  test("traversal is bounded by the graph's own step budget", () => {
    runs.forEach(({ seed, generated: run }) => {
      if (run === null) return
      const settings = run.graph["settings"]
      const declared = isJsonObject(settings) ? settings["max_graph_steps"] : undefined
      const budget = typeof declared === "number" ? declared : 1000
      const started = run.result.events.filter((event) => event.kind === "node_started").length
      expect(started, `seed ${seed}`).toBeLessThanOrEqual(budget)
    })
  })

  test("every run reaches exactly one terminal, and it is the last thing said", () => {
    runs.forEach(({ seed, generated: run }) => {
      if (run === null) return
      const finished = run.result.events.filter((event) => event.kind === "run_finished")
      expect(finished.length, `seed ${seed}`).toBe(1)
      expect(run.result.events.at(-1)?.kind).toBe("run_finished")
      expect(["completed", "failed", "cancelled"]).toContain(run.result.status)
    })
  })

  test("the terminal never contradicts itself", () => {
    runs.forEach(({ seed, generated: run }) => {
      if (run === null) return
      expect(() => validateTerminalPair(run.result.status, run.result.terminationReason), `seed ${seed}`).not.toThrow()
      const finished = run.result.events.at(-1)
      expect(finished?.payload["status"]).toBe(run.result.status)
      expect(finished?.payload["termination_reason"]).toBe(run.result.terminationReason)
      expect(finished?.payload["outcome_label"]).toBe(run.result.outcomeLabel)
      // A completed run carries an output; a failed one carries none.
      if (run.result.status !== "completed") {
        expect(run.result.output).toBeNull()
        expect(run.result.outputNodeID).toBeNull()
      }
    })
  })

  test("every stream satisfies the neutral contract's ordering rule", () => {
    runs.forEach(({ seed, generated: run }) => {
      if (run === null) return
      expect(() => validateEventOrder(run.result.events as readonly RunEventV1[]), `seed ${seed}`).not.toThrow()
    })
  })

  test("the same input and history produce the same decision stream", () => {
    runs.forEach(({ seed, generated: run }) => {
      if (run === null) return
      const again = generated(seed)
      expect(again?.result.events).toEqual(run.result.events)
      expect(again?.result.terminationReason).toBe(run.result.terminationReason)
      expect(again?.result.output).toEqual(run.result.output)
    })
  })

  test("a node is never left open: every start is matched by a finish", () => {
    runs.forEach(({ seed, generated: run }) => {
      if (run === null) return
      const started = run.result.events.filter((event) => event.kind === "node_started").map((event) => event.node_key)
      const finished = run.result.events
        .filter((event) => event.kind === "node_finished")
        .map((event) => event.node_key)
      expect(finished, `seed ${seed}`).toEqual(started)
    })
  })
})

describe("metamorphic relations", () => {
  const base = (): GraphDoc =>
    ({
      version: 3,
      name: "metamorphic",
      entry: "n_one",
      variables: [],
      nodes: [
        { id: "n_one", type: "agent", name: "One", instruction: "Do one.", position: position(0) },
        {
          id: "n_check",
          type: "condition",
          name: "Check",
          check: { kind: "url_contains", value: "x" },
          position: position(1),
        },
        { id: "n_two", type: "agent", name: "Two", instruction: "Do two.", position: position(2) },
        { id: "ok", type: "success", position: position(3) },
        { id: "bad", type: "error", position: position(4) },
      ],
      edges: [
        { id: "e1", from: "n_one", to: "n_check", when: "success" },
        { id: "e1x", from: "n_one", to: "bad", when: "error" },
        { id: "e_t", from: "n_check", to: "n_two", when: "true" },
        { id: "e_f", from: "n_check", to: "bad", when: "false" },
        { id: "e2", from: "n_two", to: "ok", when: "success" },
        { id: "e2x", from: "n_two", to: "bad", when: "error" },
      ],
    }) as GraphDoc

  const walk = (graph: GraphDoc): RunResult => {
    const program = compile(definitionBundle("root", [member([], "root", graph)]))
    return runWorkflow(
      { runID: "metamorphic", resolver: program.resolver, rootAgentID: program.rootAgentID, clock: fixedClock() },
      port(),
    )
  }

  const decisions = (result: RunResult) =>
    result.events
      .filter((event) => event.kind === "edge_taken" || event.kind === "node_started")
      .map((event) => `${event.kind}:${event.node_key}:${asString(event.payload["to"])}`)

  test("reordering the node list does not change a single decision", () => {
    const original = base()
    const nodes = original["nodes"]
    const shuffled = { ...original, nodes: [...(Array.isArray(nodes) ? nodes : [])].toReversed() } as GraphDoc
    expect(decisions(walk(shuffled))).toEqual(decisions(walk(original)))
  })

  test("reordering the edge list does not change a single decision", () => {
    const original = base()
    const edges = original["edges"]
    const shuffled = { ...original, edges: [...(Array.isArray(edges) ? edges : [])].toReversed() } as GraphDoc
    expect(decisions(walk(shuffled))).toEqual(decisions(walk(original)))
  })

  test("an unreachable node changes the digest but not the walk", () => {
    const original = base()
    const nodes = Array.isArray(original["nodes"]) ? original["nodes"] : []
    const extended = {
      ...original,
      nodes: [
        ...nodes,
        { id: "n_island", type: "agent", name: "Island", instruction: "Never run.", position: position(9) },
      ],
    } as GraphDoc
    expect(contentDigest(extended)).not.toBe(contentDigest(original))
    expect(decisions(walk(extended))).toEqual(decisions(walk(original)))
  })

  const rename = (id: string) => `renamed_${id}`

  test("renaming every node consistently produces an isomorphic stream", () => {
    const original = base()
    const nodes = (Array.isArray(original["nodes"]) ? original["nodes"] : []).map((node) =>
      isJsonObject(node) ? { ...node, id: rename(asString(node["id"])) } : node,
    )
    const edges = (Array.isArray(original["edges"]) ? original["edges"] : []).map((edge) =>
      isJsonObject(edge) ? { ...edge, from: rename(asString(edge["from"])), to: rename(asString(edge["to"])) } : edge,
    )
    const renamed = { ...original, entry: rename("n_one"), nodes, edges } as GraphDoc
    const expected = decisions(walk(original)).map((entry) =>
      entry
        .split(":")
        .map((part, index) => (index === 0 || part === "" ? part : rename(part)))
        .join(":"),
    )
    expect(decisions(walk(renamed))).toEqual(expected)
  })

  test("the same graph under a different run id decides identically", () => {
    const program = compile(definitionBundle("root", [member([], "root", base())]))
    const options = { resolver: program.resolver, rootAgentID: program.rootAgentID, clock: fixedClock() }
    const first = runWorkflow({ ...options, runID: "alpha" }, port())
    const second = runWorkflow({ ...options, runID: "beta" }, port())
    expect(decisions(second)).toEqual(decisions(first))
    expect(second.terminationReason).toBe(first.terminationReason)
  })
})

describe("fuzzing the boundaries", () => {
  /** Arbitrary JSON, shaped to reach the interesting corners quickly. */
  function randomJson(random: Random, depth = 0): JsonValue {
    const leaf: readonly JsonValue[] = [null, true, false, 0, -1, 1.5, "", "x", "~0/~1", " "]
    if (depth > 3 || random.next() < 0.5) return random.pick(leaf)
    if (random.bool()) return Array.from({ length: random.int(3) }, () => randomJson(random, depth + 1))
    return Object.fromEntries(
      Array.from({ length: random.int(3) }, (_, index) => [`k${index}`, randomJson(random, depth + 1)]),
    )
  }

  test("an arbitrary document is either accepted or refused, never a crash", () => {
    seeds.forEach((seed) => {
      const document = randomJson(new Random(seed))
      const wrapped: Readonly<Record<string, JsonValue>> = isJsonObject(document) ? document : { document }
      expect(() => acceptsGraph(wrapped)).not.toThrow()
      expect(acceptsGraph(wrapped)).toBeFalse()
    })
  })

  test("compiling an arbitrary bundle fails with a kernel error, never a stray one", () => {
    seeds.forEach((seed) => {
      const random = new Random(seed)
      const graph = randomGraph(random)
      const bundle = {
        rootAgentId: "root",
        // A digest that does not describe these members: the bundle must refuse.
        digest: "sha256:" + "0".repeat(64),
        members: [member([], "root", graph)],
      }
      try {
        compile(bundle)
        throw new Error(`seed ${seed} compiled a bundle whose digest is wrong`)
      } catch (error) {
        expect(error instanceof DefinitionError || error instanceof CompileError, `seed ${seed}`).toBeTrue()
      }
    })
  })

  test("pointer resolution refuses cleanly rather than coercing", () => {
    const pointers = ["", "/", "/a", "/0", "/a/b", "no-slash", "/~0", "/~1", "/999999"]
    seeds.slice(0, 40).forEach((seed) => {
      const random = new Random(seed)
      const value = randomJson(random)
      pointers.forEach((pointer) => {
        try {
          resolveJsonPointer(value, pointer, "fuzz")
        } catch (error) {
          expect(error).toBeInstanceOf(DataResolutionError)
        }
      })
    })
  })

  test("an arbitrary x-source annotation is parsed or refused, never guessed", () => {
    seeds.slice(0, 40).forEach((seed) => {
      const random = new Random(seed)
      const value = randomJson(random)
      try {
        const parsed = parseDataSource(value)
        expect(["run", "previous", "node", "edge"]).toContain(parsed.from)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
      }
    })
  })

  test("an arbitrary schema document is bounded or refused", () => {
    seeds.slice(0, 40).forEach((seed) => {
      const random = new Random(seed)
      const document = randomJson(random)
      try {
        validateSchemaDocument(document, { location: "fuzz" })
      } catch (error) {
        expect(error).toBeInstanceOf(ContractViolation)
      }
    })
  })

  test("instance validation never throws anything but a contract violation", () => {
    const schemas = [
      { type: "object" },
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      { type: "object", additionalProperties: false },
    ]
    seeds.slice(0, 40).forEach((seed) => {
      const random = new Random(seed)
      const instance = randomJson(random)
      schemas.forEach((schema) => {
        try {
          validateInstance(instance, schema, "fuzz")
        } catch (error) {
          expect(error).toBeInstanceOf(ContractViolation)
        }
      })
    })
  })

  test("loop item parsing is total", () => {
    const inputs: readonly (JsonValue | undefined)[] = [
      undefined,
      null,
      "",
      "  ",
      "[",
      "[1,2",
      "[1,2]",
      '{"a":1}',
      "a\nb\n\n c ",
      [1, 2, 3],
      42,
      true,
    ]
    inputs.forEach((input) => {
      expect(() => parseItems(input)).not.toThrow()
      expect(Array.isArray(parseItems(input))).toBeTrue()
    })
  })

  test("a recursive bundle with a broken closure is refused, not walked", () => {
    const child: GraphDoc = {
      version: 3,
      name: "child",
      entry: "c_one",
      variables: [],
      nodes: [
        { id: "c_one", type: "agent", name: "C", instruction: "Do.", position: position(0) },
        { id: "ok", type: "success", position: position(1) },
      ],
      edges: [{ id: "c_ok", from: "c_one", to: "ok", when: "success" }],
    } as GraphDoc
    const parent: GraphDoc = {
      version: 3,
      name: "parent",
      entry: "n_sub",
      variables: [],
      nodes: [
        {
          id: "n_sub",
          type: "subworkflow",
          name: "Sub",
          target_agent_id: "child-agent",
          input_mapping: {},
          position: position(0),
        },
        { id: "ok", type: "success", position: position(1) },
      ],
      edges: [{ id: "e_ok", from: "n_sub", to: "ok", when: "success" }],
    } as GraphDoc

    // The parent binds a child the bundle does not carry.
    expect(() => compile(definitionBundle("root", [member([], "root", parent)]))).toThrow(DefinitionError)
    // The child is present but bound at the wrong path.
    expect(() =>
      compile(definitionBundle("root", [member([], "root", parent), member(["n_other"], "child-agent", child)])),
    ).toThrow(DefinitionError)
    // Correctly bound, it compiles.
    expect(() =>
      compile(definitionBundle("root", [member([], "root", parent), member(["n_sub"], "child-agent", child)])),
    ).not.toThrow()
  })

  test("a kernel error is always a kernel error", () => {
    const failures = [
      () => validateSchemaDocument({ type: "array" }, { location: "x", objectRoot: true }),
      () => validateInstance({ a: 1 }, { type: "object", properties: { a: { type: "string" } } }, "x"),
      () => resolveJsonPointer({ a: 1 }, "/b", "x"),
    ]
    failures.forEach((failure) => {
      expect(failure).toThrow(KernelError)
    })
  })

  test("an impossible terminal pair is refused at the seam", () => {
    expect(() => validateTerminalPair("completed", TerminationReason.ReportedFailure)).toThrow()
    expect(() => validateTerminalPair("cancelled", TerminationReason.Done)).toThrow()
    expect(() => validateTerminalPair("failed", TerminationReason.Done)).toThrow()
    expect(() => validateTerminalPair("completed", TerminationReason.Done)).not.toThrow()
  })
})
