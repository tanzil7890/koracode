// Engine-side candidate normalization (v7): deterministic repairs, the local
// validator mirror, code-keyed guidance, and cross-language patch parity
// against the Python implementation (fixtures/patch-parity.json is generated
// by workflows/scripts/gen_patch_parity_fixture.py — regenerate, never edit).

import { describe, expect, test } from "bun:test"

import parity from "./fixtures/patch-parity.json"
import { PatchError, applyPatchOps, guidanceFor, lintCandidate, normalizeCandidate } from "../src/candidate-repair"

const VALID = {
  version: 3,
  name: "Base",
  entry: "n1",
  variables: [{ name: "NAME" }],
  nodes: [
    { id: "n1", type: "agent", name: "Step one", instruction: "Fill {{.NAME}}", position: { x: 0, y: 0 } },
    { id: "ok", type: "success", position: { x: 300, y: 0 } },
    { id: "err", type: "error", position: { x: 300, y: 200 } },
  ],
  edges: [
    { id: "e1", from: "n1", to: "ok", when: "success" },
    { id: "e2", from: "n1", to: "err", when: "error" },
  ],
}

describe("applyPatchOps parity with backend/workflow_proposals/patch.py", () => {
  for (const kase of parity.cases) {
    test(kase.name, () => {
      if (kase.ok) {
        expect(applyPatchOps(parity.base as Record<string, unknown>, kase.ops)).toEqual(kase.result as Record<string, unknown>)
      } else {
        let caught: unknown
        try {
          applyPatchOps(parity.base as Record<string, unknown>, kase.ops)
        } catch (error) {
          caught = error
        }
        expect(caught).toBeInstanceOf(PatchError)
        expect((caught as Error).message).toBe(kase.error as string)
      }
    })
  }

  test("never mutates the base", () => {
    const base = structuredClone(parity.base) as Record<string, unknown>
    applyPatchOps(base, [{ op: "remove_node", id: "n1" }])
    expect(base).toEqual(parity.base as Record<string, unknown>)
  })
})

describe("normalizeCandidate", () => {
  test("a valid graph is untouched and normalization is idempotent", () => {
    const once = normalizeCandidate(VALID)
    expect(once.repairs).toEqual([])
    expect(once.graph).toEqual(VALID)
    expect(normalizeCandidate(once.graph).graph).toEqual(once.graph)
  })

  test("declares every referenced template and objectifies string variables", () => {
    const { graph, repairs } = normalizeCandidate({
      ...VALID,
      variables: ["NAME"],
      nodes: [
        { ...VALID.nodes[0], instruction: "Fill {{.NAME}} and {{.EMAIL}}; prior {{.PREV_OUTPUT}} {{.NODE_N1_OUTPUT}}" },
        ...VALID.nodes.slice(1),
      ],
    })
    expect(graph["variables"]).toEqual([{ name: "NAME" }, { name: "EMAIL" }])
    expect(repairs.map((r) => r.code)).toEqual(["VARIABLE_STRING_TO_OBJECT", "VARIABLE_DECLARED"])
  })

  test("declares templates used in loop instructions and subworkflow mappings", () => {
    const { graph } = normalizeCandidate({
      ...VALID,
      variables: [],
      nodes: [
        ...VALID.nodes,
        { id: "l1", type: "loop", name: "L", items_variable: "ROWS", item_instruction: "do {{.ITEM}} for {{.USER}}", max_iterations: 5, position: { x: 1, y: 1 } },
        { id: "s1", type: "subworkflow", name: "S", target_agent_id: "child", input_mapping: { u: "{{.TOKEN}}" }, position: { x: 1, y: 1 } },
      ],
    })
    expect((graph["variables"] as { name: string }[]).map((v) => v.name).sort()).toEqual(["NAME", "TOKEN", "USER"])
  })

  test("defaults missing positions and node names without touching anything else", () => {
    const { graph, repairs } = normalizeCandidate({
      ...VALID,
      nodes: [{ id: "n1", type: "agent", instruction: "Fill {{.NAME}}" }, ...VALID.nodes.slice(1)],
    })
    const node = (graph["nodes"] as Record<string, unknown>[])[0]!
    expect(node["position"]).toEqual({ x: 0, y: 0 })
    expect(node["name"]).toBe("n1")
    expect(repairs.map((r) => r.code).sort()).toEqual(["NODE_NAME_DEFAULTED", "POSITION_DEFAULTED"])
  })

  test("moves a source-less scripts[] entry to the singular script wiring", () => {
    const { graph, repairs } = normalizeCandidate({
      ...VALID,
      nodes: [{ ...VALID.nodes[0], scripts: [{ filename: "extract_rows.js", failure_action: "fallback_to_ai" }] }, ...VALID.nodes.slice(1)],
    })
    const node = (graph["nodes"] as Record<string, unknown>[])[0]!
    expect(node["script"]).toEqual({ filepath: "./scripts/extract_rows.js", failure_action: "fallback_to_ai" })
    expect(node["scripts"]).toBeUndefined()
    expect(repairs.map((r) => r.code)).toEqual(["SCRIPTS_ENTRY_TO_SCRIPT"])
  })

  test("keeps scripts[] entries that carry source, and repairs a string script", () => {
    const { graph } = normalizeCandidate({
      ...VALID,
      nodes: [
        { ...VALID.nodes[0], script: "./scripts/a.js", scripts: [{ filename: "a.js", source: "module.exports = 1" }] },
        ...VALID.nodes.slice(1),
      ],
    })
    const node = (graph["nodes"] as Record<string, unknown>[])[0]!
    expect(node["script"]).toEqual({ filepath: "./scripts/a.js", failure_action: "fallback_to_ai" })
    expect(node["scripts"]).toEqual([{ filename: "a.js", source: "module.exports = 1" }])
  })

  test("adds or trims x-source on input_schema properties and defaults the root type", () => {
    const { graph, repairs } = normalizeCandidate({
      ...VALID,
      nodes: [
        {
          ...VALID.nodes[0],
          input_schema: {
            properties: {
              a: { type: "string" },
              b: { type: "string", "x-source": { from: "run", pointer: "/b", note: "extra" } },
              c: { type: "string", "x-source": { source: "run" } },
            },
            required: ["a"],
          },
        },
        ...VALID.nodes.slice(1),
      ],
    })
    const schema = (graph["nodes"] as Record<string, unknown>[])[0]!["input_schema"] as Record<string, unknown>
    const props = schema["properties"] as Record<string, Record<string, unknown>>
    expect(schema["type"]).toBe("object")
    expect(props["a"]!["x-source"]).toEqual({ from: "run", pointer: "/a" })
    expect(props["b"]!["x-source"]).toEqual({ from: "run", pointer: "/b" })
    expect(props["c"]!["x-source"]).toEqual({ from: "run", pointer: "/c" })
    expect(repairs.map((r) => r.code)).toEqual(["SCHEMA_ROOT_TYPE_DEFAULTED", "SCHEMA_SOURCE_ADDED", "SCHEMA_SOURCE_TRIMMED", "SCHEMA_SOURCE_ADDED"])
  })

  test("drops duplicate and over-cardinal edges, keeping the FIRST of each kind", () => {
    const { graph, repairs } = normalizeCandidate({
      ...VALID,
      edges: [
        ...VALID.edges,
        { id: "e1", from: "n1", to: "ok", when: "success" }, // exact duplicate (id + triple)
        { id: "e3", from: "n1", to: "err", when: "success" }, // second success edge
      ],
    })
    expect((graph["edges"] as { id: string }[]).map((e) => e.id)).toEqual(["e1", "e2"])
    expect(repairs.map((r) => r.code)).toEqual(["EDGE_ID_DEDUPED", "EDGE_DUPLICATE_DROPPED", "EDGE_CARDINALITY_TRIMMED"])
  })

  test("condition nodes keep the first true and first false edge only", () => {
    const { graph } = normalizeCandidate({
      ...VALID,
      nodes: [...VALID.nodes, { id: "c1", type: "condition", name: "C", check: { kind: "text_present", value: "MFA" }, position: { x: 1, y: 1 } }],
      edges: [
        { id: "e1", from: "n1", to: "c1", when: "success" },
        { id: "e2", from: "n1", to: "err", when: "error" },
        { id: "t1", from: "c1", to: "err", when: "true" },
        { id: "t2", from: "c1", to: "ok", when: "true" },
        { id: "f1", from: "c1", to: "ok", when: "false" },
      ],
    })
    expect((graph["edges"] as { id: string }[]).map((e) => e.id)).toEqual(["e1", "e2", "t1", "f1"])
  })

  test("maps when synonyms, source/target aliases, and generates missing edge ids", () => {
    const { graph, repairs } = normalizeCandidate({
      ...VALID,
      edges: [
        { source: "n1", target: "ok", when: "Success" },
        { id: "x", from: "n1", to: "err", when: "failure" },
      ],
    })
    expect(graph["edges"]).toEqual([
      { id: "n1->ok:success", from: "n1", to: "ok", when: "success" },
      { id: "x", from: "n1", to: "err", when: "error" },
    ])
    expect(repairs.map((r) => r.code)).toContain("EDGE_WHEN_SYNONYM")
  })

  test("infers the entry only when exactly one task node has no incoming edge", () => {
    const inferred = normalizeCandidate({ ...VALID, entry: undefined })
    expect(inferred.graph["entry"]).toBe("n1")
    const ambiguous = normalizeCandidate({
      ...VALID,
      entry: "missing",
      nodes: [...VALID.nodes, { id: "n2", type: "agent", name: "Two", instruction: "x", position: { x: 1, y: 1 } }],
    })
    expect(ambiguous.graph["entry"]).toBe("missing") // left for lint + guidance
    const fromHead = normalizeCandidate({ ...VALID, entry: undefined, nodes: [...VALID.nodes, { id: "n2", type: "agent", name: "Two", instruction: "x", position: { x: 1, y: 1 } }] }, { head: VALID })
    expect(fromHead.graph["entry"]).toBe("n1")
  })

  test("drops unknown capabilities, bounds loops, stringifies mappings, repairs condition checks", () => {
    const { graph, repairs } = normalizeCandidate({
      ...VALID,
      nodes: [
        { ...VALID.nodes[0], capabilities: ["browser", "files.write"] },
        ...VALID.nodes.slice(1),
        { id: "l1", type: "loop", name: "L", items_variable: "ROWS", item_instruction: "x", max_iterations: "500", position: { x: 1, y: 1 } },
        { id: "s1", type: "subworkflow", name: "S", target_agent_id: "child", input_mapping: { n: 5, o: { a: 1 } }, position: { x: 1, y: 1 } },
        { id: "c1", type: "condition", name: "C", check: { type: "text_present", text: "MFA required" }, position: { x: 1, y: 1 } },
      ],
    })
    const nodes = graph["nodes"] as Record<string, unknown>[]
    expect(nodes[0]!["capabilities"]).toEqual(["browser"])
    expect(nodes[3]!["max_iterations"]).toBe(50)
    expect(nodes[4]!["input_mapping"]).toEqual({ n: "5", o: '{"a":1}' })
    expect(nodes[5]!["check"]).toEqual({ kind: "text_present", value: "MFA required" })
    expect(repairs.map((r) => r.code)).toEqual([
      "UNKNOWN_CAPABILITY_DROPPED",
      "LOOP_BOUND_DEFAULTED",
      "INPUT_MAPPING_STRINGIFIED",
      "INPUT_MAPPING_STRINGIFIED",
      "CONDITION_CHECK_KIND_RENAMED",
      "CONDITION_CHECK_VALUE_RENAMED",
    ])
  })

  test("never invents ids, targets, or instructions", () => {
    const { graph, repairs } = normalizeCandidate({
      ...VALID,
      nodes: [{ id: "n1", type: "agent", name: "One", position: { x: 0, y: 0 } }, ...VALID.nodes.slice(1)],
      edges: [{ id: "e1", from: "n1", to: "ghost", when: "success" }],
    })
    expect((graph["nodes"] as Record<string, unknown>[])[0]!["instruction"]).toBeUndefined()
    expect((graph["edges"] as Record<string, unknown>[])[0]!["to"]).toBe("ghost")
    expect(repairs).toEqual([])
  })
})

describe("lintCandidate mirrors the validator's structural rules", () => {
  test("a valid graph has no issues", () => {
    expect(lintCandidate(VALID)).toEqual([])
  })

  test("catches the rejections the model actually produces", () => {
    const issues = lintCandidate({
      ...VALID,
      entry: "ok",
      scripts: [{ filename: "x.js" }],
      nodes: [
        { id: "n1", type: "agent", name: "One", position: { x: 0, y: 0 } }, // no instruction
        { id: "ok", type: "success", position: { x: 1, y: 1 } },
        { id: "err", type: "error", position: { x: 1, y: 1 } },
        { id: "c1", type: "condition", name: "C", check: { kind: "ai_judge", value: "x" }, position: { x: 1, y: 1 } },
        { id: "z", type: "start", position: { x: 1, y: 1 } },
      ],
      edges: [
        { id: "e1", from: "n1", to: "ghost", when: "success" },
        { id: "e2", from: "n1", to: "err", when: "true" },
        { id: "e3", from: "ok", to: "err", when: "success" },
        { id: "e4", from: "c1", to: "err", when: "success" },
        { id: "e5", from: "n1", to: "n1", when: "error" },
      ],
    })
    const codes = issues.map((i) => i.code)
    for (const expected of [
      "FIELD_REQUIRED",
      "CONDITION_CHECK_INVALID",
      "UNKNOWN_NODE_TYPE",
      "ENTRY_NOT_AGENT",
      "EDGE_ENDPOINT_MISSING",
      "EDGE_WHEN_MISMATCH",
      "TERMINAL_OUT_EDGE",
      "CONDITION_EDGES",
      "CYCLE",
      "TOP_LEVEL_SCRIPTS_IGNORED",
    ]) {
      expect(codes).toContain(expected)
    }
  })

  test("undeclared variables and cardinality are reported when normalization was skipped", () => {
    const codes = lintCandidate({
      ...VALID,
      variables: [],
      edges: [...VALID.edges, { id: "e3", from: "n1", to: "err", when: "success" }],
    }).map((i) => i.code)
    expect(codes).toContain("UNDECLARED_VARIABLE")
    expect(codes).toContain("EDGE_CARDINALITY")
  })
})

describe("guidanceFor", () => {
  test("translates pydantic error strings into exact repairs", () => {
    const hints = guidanceFor([
      "3 validation errors for WorkflowGraph\nnodes.0.agent.scripts.0.source\n  Field required [type=missing, input_value={'filename': 'x.js'}, input_type=dict]\nnodes.1.condition.position\n  Field required [type=missing]\nedges.0.when\n  Input should be 'success', 'error', 'true', 'false', 'ai' or 'selector' [type=literal_error]",
    ])
    expect(hints.some((h) => h.includes("singular script:{filepath"))).toBe(true)
    expect(hints.some((h) => h.includes("position:{x:<number>, y:<number>}"))).toBe(true)
    expect(hints.some((h) => h.includes("Edge when must be"))).toBe(true)
  })

  test("keys validator issue objects to their fix and de-duplicates", () => {
    const hints = guidanceFor([
      { code: "CONDITION_EDGES", message: 'Condition node "c1" must have exactly one "true" edge', node_id: "c1" },
      { code: "CONDITION_EDGES", message: 'Condition node "c1" must have exactly one "true" edge', node_id: "c1" },
      { code: "SCHEMA_SOURCE_REQUIRED", message: "nodes/n1/input_schema/properties/a", node_id: "n1" },
      { code: "SOMETHING_NEW", message: "unknown to the engine" },
    ])
    expect(hints).toHaveLength(3)
    expect(hints[0]).toContain("exactly one 'true' edge and exactly one 'false' edge")
    expect(hints[1]).toContain("x-source")
    expect(hints[2]).toBe("SOMETHING_NEW: unknown to the engine")
  })
})
