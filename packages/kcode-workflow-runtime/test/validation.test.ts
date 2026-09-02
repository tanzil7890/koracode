/**
 * Static accept/reject and digest parity.
 *
 * A candidate that walks a graph correctly but ACCEPTS one the reference
 * refuses would happily run a definition the product forbids. These vectors
 * record what the shipped validator said about ninety-odd graphs — the neutral
 * contract's own fixtures, every Phase 12.9 corpus graph including its
 * rejection cases, and one authored graph per named refusal — and the candidate
 * has to agree on all three answers: the verdict, the codes, and the digest.
 */
import { describe, expect, test } from "bun:test"
import vectorDocument from "../vectors/deterministic-vectors.v1.json" with { type: "json" }
import type { JsonValue, WorkflowGraphV1 } from "@koracode/kcode-workflow-contracts"
import { acceptsGraph, contentDigest, graphDigest, upgradeGraph, validateGraph } from "../src"

type ValidationVector = {
  readonly id: string
  readonly flags: Readonly<Record<string, boolean>>
  readonly graph: Readonly<Record<string, JsonValue>>
  readonly parses: boolean
  readonly accepted: boolean
  readonly error_codes: readonly string[]
  readonly warning_codes: readonly string[]
  readonly graph_digest: string
}

const vectors = (vectorDocument as unknown as { validation: readonly ValidationVector[] }).validation

function codes(vector: ValidationVector) {
  const options = { cyclicEdgesEnabled: vector.flags["cyclic_edges_enabled"] }
  const validation = validateGraph(vector.graph as unknown as WorkflowGraphV1, options)
  return {
    errors: [...new Set(validation.errors.map((issue) => issue.code))].toSorted(),
    warnings: [...new Set(validation.warnings.map((issue) => issue.code))].toSorted(),
  }
}

describe("static validation parity", () => {
  test("the document carries a broad accept/reject spread", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(80)
    expect(vectors.some((vector) => vector.accepted)).toBeTrue()
    expect(vectors.filter((vector) => !vector.accepted).length).toBeGreaterThanOrEqual(25)
    const reported = new Set(vectors.flatMap((vector) => vector.error_codes))
    expect(reported.size).toBeGreaterThanOrEqual(25)
  })

  vectors.forEach((vector) => {
    test(`${vector.id} — the same verdict, codes, and digest`, () => {
      expect(acceptsGraph(vector.graph, { cyclicEdgesEnabled: vector.flags["cyclic_edges_enabled"] })).toBe(
        vector.accepted,
      )
      const { errors, warnings } = codes(vector)
      expect(errors).toEqual([...vector.error_codes])
      expect(warnings).toEqual([...vector.warning_codes])
      expect(contentDigest(vector.graph)).toBe(vector.graph_digest)
      expect(graphDigest(vector.graph)).toBe(vector.graph_digest)
    })
  })

  test("the additive version upgrade never changes anything else", () => {
    vectors.forEach((vector) => {
      const upgraded = upgradeGraph(vector.graph)
      expect(upgraded["version"]).toBeGreaterThanOrEqual(3)
      const withoutVersion = (document: Readonly<Record<string, JsonValue>>) => {
        const copy: Record<string, JsonValue> = { ...document }
        delete copy["version"]
        return copy
      }
      expect(withoutVersion(upgraded)).toEqual(withoutVersion(vector.graph))
    })
  })
})
