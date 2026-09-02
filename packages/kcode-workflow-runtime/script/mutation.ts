/**
 * Mutation testing for the semantics that matter.
 *
 * A green suite proves the tests pass, not that they would notice if the kernel
 * were wrong. Each mutation below changes one branch, terminal, or limit — the
 * three things Phase 12.10 says the tests must catch — and the run fails if any
 * of them survives.
 *
 * Mutations are applied to the working tree and restored in `finally`; the
 * script verifies every file is byte-identical before it exits, and refuses to
 * start if the tree is already dirty in a way it cannot restore.
 */
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

type Mutation = {
  readonly id: string
  readonly file: string
  readonly find: string
  readonly replace: string
  /** What a surviving mutation would mean, in plain terms. */
  readonly meaning: string
}

const mutations: readonly Mutation[] = [
  {
    id: "limit.graph-steps-off-by-one",
    file: "src/machine.ts",
    find: "if (stepsTaken > maxSteps) {",
    replace: "if (stepsTaken > maxSteps + 1) {",
    meaning: "a graph could take one step more than its declared budget",
  },
  {
    id: "limit.node-visits-off-by-one",
    file: "src/machine.ts",
    find: "if (seen > bound) {",
    replace: "if (seen > bound + 1) {",
    meaning: "a cyclic graph could visit a node once more than its bound allows",
  },
  {
    id: "limit.loop-iterations-uncapped",
    file: "src/machine.ts",
    find: "const items = all.slice(0, node.max_iterations)",
    replace: "const items = all",
    meaning: "a bounded loop would run every item, ignoring its declared bound",
  },
  {
    id: "limit.subworkflow-depth",
    file: "src/machine.ts",
    find: "if (depth + 1 >= MAX_SUBWORKFLOW_DEPTH) {",
    replace: "if (depth + 1 > MAX_SUBWORKFLOW_DEPTH) {",
    meaning: "recursion could go one level deeper than the walker permits",
  },
  {
    id: "branch.condition-inverted",
    file: "src/machine.ts",
    find: 'nodeID = route(nodeKey, node.id, outcome.passed ? "true" : "false", "condition")',
    replace: 'nodeID = route(nodeKey, node.id, outcome.passed ? "false" : "true", "condition")',
    meaning: "a condition would take the opposite edge",
  },
  {
    id: "branch.verification-ignored",
    file: "src/machine.ts",
    find: '    if (outcome.status === "completed") {\n      const verdict = yield* verifyOutcome(control, node, nodeKey, definitionPath, current.visit)\n      if (verdict.passed) {',
    replace:
      '    if (outcome.status === "completed") {\n      const verdict = yield* verifyOutcome(control, node, nodeKey, definitionPath, current.visit)\n      if (verdict.passed || true) {',
    meaning: "a failed expected-outcome check would be treated as success",
  },
  {
    id: "branch.replay-verification-ignored",
    file: "src/machine.ts",
    find: "      if (replay.ok) {\n        const verdict = yield* verifyOutcome(control, node, nodeKey, definitionPath, current.visit)\n        if (verdict.passed) {",
    replace:
      "      if (replay.ok) {\n        const verdict = yield* verifyOutcome(control, node, nodeKey, definitionPath, current.visit)\n        if (verdict.passed || true) {",
    meaning: "a replay whose outcome check failed would be accepted instead of falling back",
  },
  {
    id: "branch.failure-role-not-latched",
    file: "src/machine.ts",
    find: '    if (target !== null && edgeRoles.get(edgeIndexKey(nodeID, when)) === "failure") {',
    replace: '    if (target !== null && edgeRoles.get(edgeIndexKey(nodeID, when)) === "never") {',
    meaning: "a declared failure route would no longer latch the run's outcome",
  },
  {
    id: "branch.transition-failure-path",
    file: "src/machine.ts",
    find: '        (contract !== undefined && contract.outcome_role === "failure")',
    replace: '        (contract !== undefined && contract.outcome_role === "never")',
    meaning: "a transition onto a failure edge would report success",
  },
  {
    id: "terminal.latch-not-honoured",
    file: "src/machine.ts",
    find: '    if (control.latched !== null) {\n      return { status: "failed", error: "Workflow completed its failure/reporting path", lastOutput }',
    replace:
      '    if (control.latched === null && false) {\n      return { status: "failed", error: "Workflow completed its failure/reporting path", lastOutput }',
    meaning: "reaching a success terminal would erase an earlier failure",
  },
  {
    id: "terminal.error-node-completes",
    file: "src/machine.ts",
    find: '      if (node.type !== "error") return completedResult()',
    replace: '      if (node.type !== "success") return completedResult()',
    meaning: "an error terminal would end the run successfully",
  },
  {
    id: "terminal.latch-first-write-wins",
    file: "src/machine.ts",
    find: "  if (control.latched === null) control.latched = reason",
    replace: "  control.latched = reason",
    meaning: "a later reason would overwrite the first, losing why the run really failed",
  },
  {
    id: "terminal.output-schema-reason",
    file: "src/machine.ts",
    find: '          latch(control, TerminationReason.OutputSchemaValidationFailed)\n          return { status: "failed", error: "Output payload failed schema validation", lastOutput }',
    replace:
      '          latch(control, TerminationReason.ReportedFailure)\n          return { status: "failed", error: "Output payload failed schema validation", lastOutput }',
    meaning: "a schema violation would be reported as an ordinary failure",
  },
  {
    id: "terminal.contract-violation-routes-error",
    file: "src/machine.ts",
    find: '      // No error edge is consulted: an unsatisfiable contract ends the run.\n      return { status: "failed", error: state.error, lastOutput }',
    replace:
      '      nodeID = route(nodeKey, node.id, "error")\n      if (nodeID === null) return { status: "failed", error: state.error, lastOutput }\n      continue',
    meaning: "an unsatisfiable input contract would be routed like a task failure",
  },
  {
    id: "terminal.cancel-before-terminal",
    file: "src/machine.ts",
    find: '    if (isCancelled(control)) return { status: "cancelled", error: null, lastOutput }\n\n    const nodeKey =',
    replace: '    if (false) return { status: "cancelled", error: null, lastOutput }\n\n    const nodeKey =',
    meaning: "a cancel requested between nodes would be ignored",
  },
  {
    id: "terminal.outcome-label-execution-limit",
    file: "src/terminal.ts",
    find: '  if (executionLimit.includes(reason)) return "execution_limit"',
    replace: '  if (executionLimit.includes(reason)) return "reported_failure"',
    meaning: "hitting a budget would be indistinguishable from a reported failure",
  },
  {
    id: "terminal.pair-validation-disabled",
    file: "src/terminal.ts",
    find: '  if (status === "completed" && reason !== TerminationReason.Done) {',
    replace: '  if (false && status === "completed" && reason !== TerminationReason.Done) {',
    meaning: "a run could claim to have completed for a failure reason",
  },
  {
    id: "state.previous-output-not-published",
    file: "src/machine.ts",
    find: '        context.set("PREV_OUTPUT", output)',
    replace: '        context.set("PREV_OUTPUT", "")',
    meaning: "a following node would no longer see the previous node's output",
  },
  {
    id: "validation.cycle-single-opt-in",
    file: "src/validate.ts",
    find: "  const allowed = Boolean(graph.settings?.allow_cycles) && Boolean(options.cyclicEdgesEnabled)",
    replace: "  const allowed = Boolean(graph.settings?.allow_cycles) || Boolean(options.cyclicEdgesEnabled)",
    meaning: "a cycle would be accepted on half of its required double opt-in",
  },
  {
    id: "validation.loop-bounds",
    file: "src/validate.ts",
    find: '      if (node.type === "loop" && !(node.max_iterations >= 1 && node.max_iterations <= 50)) {',
    replace: '      if (node.type === "loop" && !(node.max_iterations >= 1)) {',
    meaning: "an unbounded loop would pass validation",
  },
  {
    id: "digest.member-order",
    file: "src/bundle.ts",
    find: "    return left.path.length - right.path.length",
    replace: "    return right.path.length - left.path.length",
    meaning: "a recursive definition would digest differently from the reference",
  },
]

async function run(): Promise<number> {
  const originals = new Map<string, string>()
  for (const mutation of mutations) {
    if (originals.has(mutation.file)) continue
    originals.set(mutation.file, await Bun.file(resolve(root, mutation.file)).text())
  }
  for (const mutation of mutations) {
    const source = originals.get(mutation.file) ?? ""
    const occurrences = source.split(mutation.find).length - 1
    if (occurrences !== 1) {
      console.error(`${mutation.id}: its anchor appears ${occurrences} time(s) in ${mutation.file}, expected exactly 1`)
      return 1
    }
  }

  const survivors: Mutation[] = []
  try {
    for (const mutation of mutations) {
      const source = originals.get(mutation.file) ?? ""
      await Bun.write(resolve(root, mutation.file), source.replace(mutation.find, mutation.replace))
      const killed = !(await suitePasses())
      process.stdout.write(`${killed ? "killed " : "SURVIVED"}  ${mutation.id}\n`)
      if (!killed) survivors.push(mutation)
      await Bun.write(resolve(root, mutation.file), source)
    }
  } finally {
    for (const [file, source] of originals) await Bun.write(resolve(root, file), source)
  }

  for (const [file, source] of originals) {
    if ((await Bun.file(resolve(root, file)).text()) !== source) {
      console.error(`${file} was not restored; restore it from version control before continuing`)
      return 1
    }
  }

  if (survivors.length > 0) {
    console.error("\nmutations the suite did not notice:")
    survivors.forEach((mutation) => console.error(`  ${mutation.id}: ${mutation.meaning}`))
    return 1
  }
  console.log(`\nall ${mutations.length} semantic mutations were caught`)
  return 0
}

async function suitePasses(): Promise<boolean> {
  const child = Bun.spawn(["bun", "test", "test"], { cwd: root, stdout: "ignore", stderr: "ignore" })
  return (await child.exited) === 0
}

if (import.meta.main) process.exit(await run())
