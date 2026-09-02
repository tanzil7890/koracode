import { describe, expect, test } from "bun:test"
import { TerminationReason, validateEventOrderOrThrow } from "./order"
import { edgesTaken, kinds, nodePath, port, position, programOf, programWithChild, run, terminals } from "./support"
import type { GraphDoc } from "./support"

const agent = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  type: "agent",
  name: id.replaceAll("_", " "),
  instruction: `do ${id}`,
  position: position(0),
  ...extra,
})

const linear = (nodes: readonly unknown[], entry: string, edges: readonly unknown[]): GraphDoc =>
  ({ version: 3, name: "case", entry, variables: [], nodes, edges }) as GraphDoc

describe("classic traversal", () => {
  test("walks entry to a success terminal and reports an affirmative completion", () => {
    const program = programOf(
      linear([agent("n_one"), agent("n_two", { position: position(1) }), ...terminals(2)], "n_one", [
        { id: "e1", from: "n_one", to: "n_two", when: "success" },
        { id: "e1x", from: "n_one", to: "bad", when: "error" },
        { id: "e2", from: "n_two", to: "ok", when: "success" },
        { id: "e2x", from: "n_two", to: "bad", when: "error" },
      ]),
    )
    const result = run(program)

    expect(result.status).toBe("completed")
    expect(result.terminationReason).toBe(TerminationReason.Done)
    expect(result.outcomeLabel).toBe("completed")
    expect(result.output).toBe("n_two output")
    expect(nodePath(result.events)).toEqual(["n_one", "n_two"])
    expect(edgesTaken(result.events)).toEqual([
      ["success", "n_two"],
      ["success", "ok"],
    ])
    validateEventOrderOrThrow(result.events)
  })

  test("a failed node takes its error edge and the error terminal latches reported_failure", () => {
    const program = programOf(
      linear([agent("n_one"), ...terminals(1)], "n_one", [
        { id: "e1", from: "n_one", to: "ok", when: "success" },
        { id: "e2", from: "n_one", to: "bad", when: "error" },
      ]),
    )
    const result = run(program, port({ agent: () => ({ status: "failed", error: "nope", isSuccessful: false }) }))

    expect(result.status).toBe("failed")
    expect(result.terminationReason).toBe(TerminationReason.ReportedFailure)
    expect(result.outcomeLabel).toBe("reported_failure")
    expect(result.error).toBe("Run reached the error terminal")
    expect(edgesTaken(result.events)).toEqual([["error", "bad"]])
  })

  test("a missing success edge ends the walk on the node itself", () => {
    const program = programOf(
      linear([agent("n_one"), ...terminals(1)], "n_one", [{ id: "e2", from: "n_one", to: "bad", when: "error" }]),
    )
    const result = run(program)

    expect(result.status).toBe("completed")
    expect(edgesTaken(result.events)).toEqual([["success", null]])
    expect(result.output).toBe("n_one output")
  })

  test("reaching a success terminal never erases a latched failure", () => {
    const program = programOf(
      linear([agent("n_one"), agent("n_cleanup", { position: position(1) }), ...terminals(2)], "n_one", [
        { id: "e1", from: "n_one", to: "ok", when: "success" },
        { id: "e2", from: "n_one", to: "n_cleanup", when: "error", outcome_role: "failure" },
        { id: "e3", from: "n_cleanup", to: "ok", when: "success" },
      ]),
    )
    const result = run(
      program,
      port({
        agent: (request) =>
          request.nodeId === "n_one" ? { status: "failed", error: "x" } : { status: "completed", output: "cleaned" },
      }),
    )

    expect(result.status).toBe("failed")
    expect(result.error).toBe("Workflow completed its failure/reporting path")
    expect(result.terminationReason).toBe(TerminationReason.ReportedFailure)
  })

  test("a continue-labelled failure route keeps the run clean", () => {
    const program = programOf(
      linear([agent("n_one"), agent("n_report", { position: position(1) }), ...terminals(2)], "n_one", [
        { id: "e1", from: "n_one", to: "ok", when: "success" },
        { id: "e2", from: "n_one", to: "n_report", when: "error", outcome_role: "continue" },
        { id: "e3", from: "n_report", to: "ok", when: "success" },
      ]),
    )
    const result = run(
      program,
      port({
        agent: (request) =>
          request.nodeId === "n_one"
            ? { status: "failed", error: "x", terminationReason: TerminationReason.ReportedFailure }
            : { status: "completed", output: "reported" },
      }),
    )

    // The node's own failure still latches; only the edge role is "continue".
    expect(result.status).toBe("failed")
  })
})

describe("condition nodes", () => {
  const conditionGraph = (): GraphDoc =>
    linear(
      [
        agent("n_arrive"),
        {
          id: "n_check",
          type: "condition",
          name: "Check",
          check: { kind: "url_contains", value: "index.html" },
          position: position(1),
        },
        ...terminals(2),
      ],
      "n_arrive",
      [
        { id: "e_go", from: "n_arrive", to: "n_check", when: "success" },
        { id: "e_err", from: "n_arrive", to: "bad", when: "error" },
        { id: "e_true", from: "n_check", to: "ok", when: "true" },
        { id: "e_false", from: "n_check", to: "bad", when: "false" },
      ],
    )

  test("routes the true edge and publishes a structured result", () => {
    const result = run(
      programOf(conditionGraph()),
      port({ condition: () => ({ passed: true, detail: "url is 'x/index.html'" }) }),
    )

    expect(result.status).toBe("completed")
    expect(edgesTaken(result.events)).toEqual([
      ["success", "n_check"],
      ["true", "ok"],
    ])
    const evaluated = result.events.find((event) => event.kind === "condition_eval")
    expect(evaluated?.payload).toEqual({ kind: "url_contains", value: "index.html", result: true, edge: "true" })
    expect(result.nodeStates["n_check"]?.output).toBe("url_contains('index.html') → True (url is 'x/index.html')")
    expect(result.nodeStates["n_check"]?.mode).toBe("deterministic")
  })

  test("routes the false edge without any error path of its own", () => {
    const result = run(
      programOf(conditionGraph()),
      port({ condition: () => ({ passed: false, detail: "check errored: boom" }) }),
    )

    expect(result.status).toBe("failed")
    expect(result.terminationReason).toBe(TerminationReason.ReportedFailure)
    expect(edgesTaken(result.events)).toEqual([
      ["success", "n_check"],
      ["false", "bad"],
    ])
  })

  test("a condition never becomes the previous output for a following node", () => {
    const result = run(programOf(conditionGraph()), port({ condition: () => ({ passed: true, detail: "d" }) }))
    expect(result.output).toBe("n_arrive output")
  })
})

describe("bounded loops", () => {
  const loopGraph = (maxIterations: number): GraphDoc =>
    linear(
      [
        {
          id: "n_loop",
          type: "loop",
          name: "Visit each row",
          items_variable: "ROWS",
          item_instruction: "Report {{.ITEM}}.",
          max_iterations: maxIterations,
          position: position(0),
        },
        ...terminals(1),
      ],
      "n_loop",
      [
        { id: "e_ok", from: "n_loop", to: "ok", when: "success" },
        { id: "e_err", from: "n_loop", to: "bad", when: "error" },
      ],
    )

  test("runs one pass per item and publishes the list", () => {
    const result = run(programOf(loopGraph(5)), port(), { runInput: { ROWS: ["Alpha", "Beta"] } })

    expect(result.status).toBe("completed")
    expect(result.output).toEqual(["item 0", "item 1"])
    // The reference stores the list with `json.dumps` defaults, not compact.
    expect(result.nodeStates["n_loop"]?.output).toBe('["item 0", "item 1"]')
    expect(kinds(result.events).filter((kind) => kind === "loop_item_started")).toHaveLength(2)
  })

  test("silently drops items beyond the declared bound and records why", () => {
    const result = run(programOf(loopGraph(2)), port(), { runInput: { ROWS: ["a", "b", "c", "d"] } })

    expect(result.status).toBe("completed")
    expect(result.output).toEqual(["item 0", "item 1"])
    expect(result.nodeStates["n_loop"]?.logs.at(-1)?.message).toBe("2 item(s) beyond max_iterations were skipped")
  })

  test("the first failing item stops the loop and names its position", () => {
    const result = run(
      programOf(loopGraph(5)),
      port({
        loopItem: (request) =>
          request.index === 1 ? { status: "failed", error: "bad row" } : { status: "completed", output: "fine" },
      }),
      { runInput: { ROWS: ["a", "b", "c"] } },
    )

    expect(result.status).toBe("failed")
    expect(result.nodeStates["n_loop"]?.error).toBe("item 2 failed: bad row")
    expect(kinds(result.events).filter((kind) => kind === "loop_item_started")).toHaveLength(2)
    expect(edgesTaken(result.events)).toEqual([["error", "bad"]])
  })

  test("a newline string is a legacy item list", () => {
    const result = run(programOf(loopGraph(5)), port(), { runInput: { ROWS: "Alpha\n\nBeta\n" } })
    expect(result.output).toEqual(["item 0", "item 1"])
  })
})

describe("subworkflows", () => {
  const child = (): GraphDoc =>
    linear([agent("n_child"), ...terminals(1)], "n_child", [
      { id: "c_ok", from: "n_child", to: "ok", when: "success" },
      { id: "c_err", from: "n_child", to: "bad", when: "error" },
    ])

  const parent = (): GraphDoc =>
    linear(
      [
        {
          id: "n_sub",
          type: "subworkflow",
          name: "Run child",
          target_agent_id: "child-agent",
          input_mapping: { BASE: "{{.BASE}}" },
          position: position(0),
        },
        ...terminals(1),
      ],
      "n_sub",
      [
        { id: "e_ok", from: "n_sub", to: "ok", when: "success" },
        { id: "e_err", from: "n_sub", to: "bad", when: "error" },
      ],
    )

  test("resolves the child by pinned path and carries its output back", () => {
    const program = programWithChild({ ...parent(), variables: [{ name: "BASE" }] }, "n_sub", "child-agent", child())
    const result = run(program, port(), { runInput: { BASE: "https://example.invalid" } })

    expect(result.status).toBe("completed")
    expect(result.output).toBe("n_child output")
    expect(nodePath(result.events)).toEqual(["n_sub", "n_sub/n_child"])
    const entered = result.events.find((event) => event.kind === "subworkflow_entered")
    expect(entered?.payload["definition_path"]).toEqual(["n_sub"])
    expect(entered?.payload["content_hash"]).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("the child's own reason wins, because the latch is shared and first-write-wins", () => {
    const program = programWithChild({ ...parent(), variables: [{ name: "BASE" }] }, "n_sub", "child-agent", child())
    const result = run(program, port({ agent: () => ({ status: "failed", error: "child broke" }) }), {
      runInput: { BASE: "x" },
    })

    expect(result.status).toBe("failed")
    // The child latched first, so the parent's definition_invalid never lands.
    expect(result.terminationReason).toBe(TerminationReason.ReportedFailure)
    expect(result.nodeStates["n_sub"]?.error).toBe("Run reached the error terminal")
  })

  test("a child that fails without latching leaves the parent's definition_invalid standing", () => {
    const unlatchable = linear([agent("n_pick"), ...terminals(1)], "n_pick", [
      { id: "t_ok", from: "n_pick", to: "ok", when: "ai", label: "go on" },
      { id: "t_bad", from: "n_pick", to: "bad", when: "ai", label: "give up" },
    ])
    const program = programWithChild(
      { ...parent(), variables: [{ name: "BASE" }] },
      "n_sub",
      "child-agent",
      unlatchable,
    )
    const result = run(program, port(), { runInput: { BASE: "x" } })

    expect(result.status).toBe("failed")
    expect(result.terminationReason).toBe(TerminationReason.DefinitionInvalid)
    expect(result.outcomeLabel).toBe("contract_violation")
    expect(edgesTaken(result.events)).toEqual([["error", "bad"]])
  })
})

describe("output nodes", () => {
  const outputGraph = (schema: unknown, binding?: unknown): GraphDoc =>
    linear(
      [
        agent("n_one"),
        {
          id: "n_out",
          type: "output",
          name: "Result",
          output_schema: schema,
          output_binding: binding,
          position: position(1),
        },
        ...terminals(2),
      ],
      "n_one",
      [
        { id: "e1", from: "n_one", to: "n_out", when: "success" },
        { id: "e2", from: "n_one", to: "bad", when: "error" },
      ],
    )

  test("parses a JSON string against the declared schema", () => {
    const program = programOf(
      outputGraph({ type: "object", properties: { total: { type: "integer" } }, required: ["total"] }),
    )
    const result = run(program, port({ agent: () => ({ status: "completed", output: '{"total": 4}' }) }))

    expect(result.status).toBe("completed")
    expect(result.output).toEqual({ total: 4 })
    expect(result.outputNodeID).toBe("n_out")
  })

  test("a payload that violates the schema is a contract violation, not a success", () => {
    const program = programOf(
      outputGraph({ type: "object", properties: { total: { type: "integer" } }, required: ["total"] }),
    )
    const result = run(program, port({ agent: () => ({ status: "completed", output: '{"total": "four"}' }) }))

    expect(result.status).toBe("failed")
    expect(result.terminationReason).toBe(TerminationReason.OutputSchemaValidationFailed)
    expect(result.outcomeLabel).toBe("contract_violation")
    expect(result.error).toBe("Output payload failed schema validation")
  })

  test("free text passes through when no schema is declared", () => {
    const result = run(
      programOf(outputGraph(null)),
      port({ agent: () => ({ status: "completed", output: "plain words" }) }),
    )
    expect(result.status).toBe("completed")
    expect(result.output).toBe("plain words")
  })

  test("a typed binding wins over the previous output", () => {
    const program = programOf(outputGraph(null, { from: "node", node_id: "n_one", pointer: "/total" }))
    const result = run(program, port({ agent: () => ({ status: "completed", output: { total: 9 } }) }))
    expect(result.output).toBe(9)
  })
})

describe("limits", () => {
  test("the graph step budget is a terminal, and an execution_limit label", () => {
    const graph = {
      ...linear([agent("n_one"), agent("n_two", { position: position(1) }), ...terminals(2)], "n_one", [
        { id: "e1", from: "n_one", to: "n_two", when: "success" },
        { id: "e1x", from: "n_one", to: "bad", when: "error" },
        { id: "e2", from: "n_two", to: "ok", when: "success" },
        { id: "e2x", from: "n_two", to: "bad", when: "error" },
      ]),
      settings: { max_graph_steps: 1 },
    } as GraphDoc
    const result = run(programOf(graph))

    expect(result.status).toBe("failed")
    expect(result.terminationReason).toBe(TerminationReason.GraphStepLimit)
    expect(result.outcomeLabel).toBe("execution_limit")
    expect(result.error).toBe("Graph step limit (1) exceeded")
  })

  test("cancellation between nodes is an affirmative cancelled terminal", () => {
    const program = programOf(
      linear([agent("n_one"), agent("n_two", { position: position(1) }), ...terminals(2)], "n_one", [
        { id: "e1", from: "n_one", to: "n_two", when: "success" },
        { id: "e1x", from: "n_one", to: "bad", when: "error" },
        { id: "e2", from: "n_two", to: "ok", when: "success" },
        { id: "e2x", from: "n_two", to: "bad", when: "error" },
      ]),
    )
    let seen = 0
    const result = run(program, port(), {
      isCancelled: () => {
        seen += 1
        return seen > 1
      },
    })

    expect(result.status).toBe("cancelled")
    expect(result.terminationReason).toBe(TerminationReason.Cancelled)
    expect(result.outcomeLabel).toBe("cancelled")
  })

  test("cancellation is polled between nodes, not only after a task returns", () => {
    // Every other cancel check sits next to a task outcome, so a scenario that
    // cancels during a task cannot tell the two apart. This one cancels only on
    // the poll that happens before the SECOND node starts, which is the one
    // that lets a run stop cleanly while nothing is in flight.
    const program = programOf(
      linear([agent("n_one"), agent("n_two", { position: position(1) }), ...terminals(2)], "n_one", [
        { id: "e1", from: "n_one", to: "n_two", when: "success" },
        { id: "e1x", from: "n_one", to: "bad", when: "error" },
        { id: "e2", from: "n_two", to: "ok", when: "success" },
        { id: "e2x", from: "n_two", to: "bad", when: "error" },
      ]),
    )
    let polls = 0
    const result = run(program, port(), {
      isCancelled: () => {
        polls += 1
        return polls === 3
      },
    })

    expect(result.status).toBe("cancelled")
    expect(nodePath(result.events)).toEqual(["n_one"])
    expect(result.nodeStates["n_two"]).toBeUndefined()
  })

  test("an unsatisfiable node input contract ends the run without consulting an error edge", () => {
    const program = programOf(
      linear(
        [
          agent("n_one", {
            input_schema: {
              type: "object",
              properties: { picked: { type: "string", "x-source": { from: "node", node_id: "n_absent" } } },
              required: ["picked"],
            },
          }),
          ...terminals(1),
        ],
        "n_one",
        [
          { id: "e1", from: "n_one", to: "ok", when: "success" },
          { id: "e2", from: "n_one", to: "bad", when: "error" },
        ],
      ),
    )
    const result = run(program)

    expect(result.status).toBe("failed")
    expect(result.terminationReason).toBe(TerminationReason.ContractViolation)
    expect(result.error).toBe("Node runtime contract could not be resolved")
    expect(edgesTaken(result.events)).toEqual([])
  })
})

describe("expected outcome", () => {
  test("a failed structured check routes the error edge and latches output_schema_validation_failed", () => {
    const program = programOf(
      linear(
        [agent("n_one", { expected_outcome: { kind: "text_present", value: "Done" } }), ...terminals(1)],
        "n_one",
        [
          { id: "e1", from: "n_one", to: "ok", when: "success" },
          { id: "e2", from: "n_one", to: "bad", when: "error" },
        ],
      ),
    )
    const result = run(program, port({ verification: () => ({ passed: false, detail: "text not found on page" }) }))

    expect(result.status).toBe("failed")
    // The verification gate reuses the output-contract reason: the task ran,
    // but the state it claimed was never confirmed.
    expect(result.terminationReason).toBe(TerminationReason.OutputSchemaValidationFailed)
    expect(result.outcomeLabel).toBe("contract_violation")
    expect(result.nodeStates["n_one"]?.error).toBe("Expected outcome not met: text not found on page")
    expect(result.events.some((event) => event.kind === "verification")).toBeTrue()
  })

  test("a plain-string expected outcome is documentation and never asks the world", () => {
    const program = programOf(
      linear([agent("n_one", { expected_outcome: "the dashboard loads" }), ...terminals(1)], "n_one", [
        { id: "e1", from: "n_one", to: "ok", when: "success" },
        { id: "e2", from: "n_one", to: "bad", when: "error" },
      ]),
    )
    const result = run(program, port({ verification: () => ({ passed: false, detail: "should never run" }) }))

    expect(result.status).toBe("completed")
    expect(result.events.some((event) => event.kind === "verification")).toBeFalse()
  })
})

describe("transition mode", () => {
  const transitionGraph = (): GraphDoc =>
    linear([agent("n_pick"), agent("n_next", { position: position(1) }), ...terminals(2)], "n_pick", [
      { id: "t_ok", from: "n_pick", to: "n_next", when: "ai", label: "continue" },
      { id: "t_bad", from: "n_pick", to: "bad", when: "ai", label: "give up" },
      { id: "e_next", from: "n_next", to: "ok", when: "success" },
      { id: "e_next_err", from: "n_next", to: "bad", when: "error" },
    ])

  test("refuses loudly when the node loop is not enabled", () => {
    const result = run(programOf(transitionGraph()))

    expect(result.status).toBe("failed")
    expect(result.error).toBe("Node has ai/selector transition edges but NODE_LOOP_ENABLED is off")
    expect(result.terminationReason).toBe(TerminationReason.Exception)
    expect(result.outcomeLabel).toBe("indeterminate")
  })

  test("takes the chosen edge and records it with its id", () => {
    const result = run(
      programOf(transitionGraph()),
      port({
        transition: () => ({
          status: "completed",
          output: "picked",
          edge: { edgeId: "t_ok", to: "n_next", via: "handoff", payload: { seen: true } },
        }),
      }),
      { flags: { nodeLoopEnabled: true } },
    )

    expect(result.status).toBe("completed")
    const chosen = result.events.find((event) => event.kind === "edge_taken")
    expect(chosen?.payload).toEqual({ when: "transition", to: "n_next", via: "handoff", edge_id: "t_ok" })
  })

  test("no handoff at all is a failure, not a quiet success", () => {
    const result = run(
      programOf(transitionGraph()),
      port({
        transition: () => ({
          status: "failed",
          terminationReason: TerminationReason.NoHandoff,
          edge: null,
          error: "Node ended without choosing a transition",
        }),
      }),
      { flags: { nodeLoopEnabled: true } },
    )

    expect(result.status).toBe("failed")
    expect(result.terminationReason).toBe(TerminationReason.NoHandoff)
    expect(result.outcomeLabel).toBe("reported_failure")
  })
})
