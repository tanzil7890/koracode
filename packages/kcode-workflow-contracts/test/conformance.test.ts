import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  canonicalDigest,
  canonicalize,
  EventOrderViolation,
  isJsonValue,
  isRunEvent,
  isWorkflowGraph,
  negotiateProtocol,
  ProtocolNegotiationError,
  upgradeGraph,
  validateEventOrder,
  validateRunEvent,
  validateRuntimeResult,
  validateWorkflowGraph,
  validateWorkflowInteraction,
} from "../src"

const contract = resolve(import.meta.dir, "../contract")

describe("shared workflow protocol corpus", () => {
  test("accepts and rejects the same graph fixtures as Python", async () => {
    const index = requireFixtureIndex(await readJson("fixtures/fixture-index.json"))
    const valid = await Promise.all(
      index.valid_workflow_graphs.map(async (relative) => validateWorkflowGraph(await readJson("fixtures", relative))),
    )
    const invalid = await Promise.all(
      index.invalid_workflow_graphs.map(async (relative) =>
        validateWorkflowGraph(await readJson("fixtures", relative)),
      ),
    )

    expect(valid.every((result) => result.valid)).toBeTrue()
    expect(invalid.every((result) => !result.valid)).toBeTrue()
    invalid.forEach((result, position) => {
      const fixture = index.invalid_workflow_graphs[position]
      const expected = index.invalid_workflow_graph_expectations[fixture ?? ""]
      if (!expected) throw new Error(`missing expectation for ${fixture}`)
      expect(result.issues.map((issue) => issue.code)).toContain(expected)
    })
  })

  test("matches RFC 8785 bytes and SHA-256 vectors", async () => {
    const vectors = requireDigestVectors(await readJson("fixtures/digest-vectors.v1.json"))

    vectors.forEach((vector) => {
      expect(canonicalize(vector.value)).toBe(vector.canonical_utf8)
      expect(canonicalDigest(vector.value)).toBe(vector.sha256)
    })
  })

  test("validates event wire shape before semantic ordering", async () => {
    const valid = requireEvents(await readJson("fixtures/events/valid.json"))
    const invalid = requireEvents(await readJson("fixtures/events/invalid.json"))
    expect([...valid, ...invalid].every((event) => validateRunEvent(event).valid)).toBeTrue()
    expect(() => validateEventOrder(valid)).not.toThrow()
    expect(() => validateEventOrder(invalid)).toThrow(EventOrderViolation)
  })

  test("keeps lifecycle status separate from outcome label", () => {
    const valid = readJson("fixtures/results/valid-timeout.json")
    const invalid = readJson("fixtures/results/invalid-v2-reader.json")
    return Promise.all([valid, invalid]).then(([accepted, rejected]) => {
      expect(validateRuntimeResult(accepted).valid).toBeTrue()
      expect(validateRuntimeResult(rejected).valid).toBeFalse()
    })
  })

  test("upgrades the additive legacy graph without changing its content", async () => {
    const fixture = requireRecord(await readJson("fixtures/compatibility/upgrade-v1-to-v3.json"))
    expect(upgradeGraph(requireWorkflowGraph(fixture.input))).toEqual(requireWorkflowGraph(fixture.expected))
  })

  test("negotiates exact v1 and rejects unsupported writers", () => {
    expect(negotiateProtocol(["v2", "v1"])).toBe("v1")
    expect(() => negotiateProtocol(["v2"])).toThrow(ProtocolNegotiationError)
  })

  test("binds backend capabilities to the typed interaction kind", () => {
    const valid = {
      protocol_version: "v1",
      run_id: "run-1",
      kind: "backend_capabilities",
      input: null,
      authorization: null,
      control: null,
      capabilities: {
        backend: "python",
        backend_version: "1",
        supports_input_request: false,
        supports_authorization_request: false,
        supports_pause: false,
        supports_resume: false,
        supports_cancel: true,
      },
    }
    expect(validateWorkflowInteraction(valid).valid).toBeTrue()
    expect(
      validateWorkflowInteraction({ ...valid, capabilities: null, input: { request_id: "wrong" } }).valid,
    ).toBeFalse()
  })
})

async function readJson(...parts: string[]): Promise<unknown> {
  return JSON.parse(await Bun.file(resolve(contract, ...parts)).text())
}

function requireFixtureIndex(value: unknown) {
  const record = requireRecord(value)
  const expectations = requireRecord(record.invalid_workflow_graph_expectations)
  const invalid_workflow_graph_expectations = Object.fromEntries(
    Object.entries(expectations).map(([key, expected]) => {
      if (typeof expected !== "string") throw new Error(`invalid expectation for ${key}`)
      return [key, expected]
    }),
  )
  return {
    valid_workflow_graphs: requireStrings(record.valid_workflow_graphs),
    invalid_workflow_graphs: requireStrings(record.invalid_workflow_graphs),
    invalid_workflow_graph_expectations,
  }
}

function requireDigestVectors(value: unknown) {
  if (!Array.isArray(value)) throw new Error("digest vectors must be an array")
  return value.map((item) => {
    const record = requireRecord(item)
    if (!isJsonValue(record.value)) throw new Error("digest vector value is not JSON")
    if (typeof record.canonical_utf8 !== "string" || typeof record.sha256 !== "string") {
      throw new Error("digest vector metadata is invalid")
    }
    return { value: record.value, canonical_utf8: record.canonical_utf8, sha256: record.sha256 }
  })
}

function requireEvents(value: unknown) {
  if (!Array.isArray(value)) throw new Error("events must be an array")
  return value.map((event) => {
    if (!isRunEvent(event)) throw new Error("event fixture failed wire validation")
    return event
  })
}

function requireWorkflowGraph(value: unknown) {
  if (!isWorkflowGraph(value)) throw new Error("workflow fixture failed validation")
  return value
}

function requireStrings(value: unknown) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("fixture paths must be strings")
  }
  return value.filter((item): item is string => typeof item === "string")
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new Error("expected JSON object")
  return value
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
