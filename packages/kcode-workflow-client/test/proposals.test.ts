// Phase 12.6 tests: the proposal tool surface is get/validate/propose/diff
// ONLY — no approve/apply anywhere on the client — and the read-only profile
// from 12.4/12.5 gains nothing.

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { WorkflowControlPlaneClient } from "../src/client"
import { MANAGED_WORKFLOW_PROFILE, PROPOSAL_WORKFLOW_PROFILE, profileAllows } from "../src/profile"
import { ToolDeniedError, WORKFLOW_PROPOSAL_TOOLS, resolveProposalTool, resolveTool } from "../src/tools"

const POLICY = { allowedOrigins: ["https://kora.internal:8000"] }

function clientWith(handler: (url: string, init?: RequestInit) => Response) {
  const seen: { url?: string; init?: RequestInit } = {}
  const client = new WorkflowControlPlaneClient({
    baseUrl: "https://kora.internal:8000",
    tokenProvider: () => "short-lived-token",
    policy: POLICY,
    fetchImpl: (async (url: any, init?: RequestInit) => {
      seen.url = String(url)
      seen.init = init
      return handler(String(url), init)
    }) as typeof fetch,
  })
  return { client, seen }
}

describe("proposal client operations", () => {
  test("propose posts the exact gateway path with base binding and idempotency key", async () => {
    const { client, seen } = clientWith(() => Response.json({ change_set_id: "cs-1", status: "proposed" }))
    await client.propose("agent-1", {
      base_generation: 4,
      base_hash: "sha256:abc",
      candidate_graph: { name: "wf", nodes: [], edges: [] },
      idempotency_key: "turn-9:1",
    })
    expect(seen.url).toBe("https://kora.internal:8000/internal/kora/v1/workflows/agent-1/proposals")
    expect(seen.init?.method).toBe("POST")
    const body = JSON.parse(String(seen.init?.body))
    expect(body.base_generation).toBe(4)
    expect(body.base_hash).toBe("sha256:abc")
    expect(body.idempotency_key).toBe("turn-9:1")
  })

  test("validate and status hit their exact paths", async () => {
    const { client, seen } = clientWith(() => Response.json({}))
    await client.validateProposal("agent-1", { nodes: [] })
    expect(seen.url).toBe("https://kora.internal:8000/internal/kora/v1/workflows/agent-1/proposals/validate")
    await client.proposalStatus("agent-1", "cs-1")
    expect(seen.url).toBe("https://kora.internal:8000/internal/kora/v1/workflows/agent-1/proposals/cs-1")
    expect(seen.init?.method).toBe("GET")
  })

  test("the client has NO approve or apply method", () => {
    const surface = Object.getOwnPropertyNames(WorkflowControlPlaneClient.prototype)
    expect(surface.some((name) => /approve|apply/i.test(name))).toBe(false)
  })
})

describe("proposal tool surface", () => {
  test("the proposal resolver serves read + proposal tools and nothing else", () => {
    for (const tool of WORKFLOW_PROPOSAL_TOOLS) expect(resolveProposalTool(tool.id).id).toBe(tool.id)
    expect(resolveProposalTool("workflow_head").id).toBe("workflow_head")
    for (const denied of ["workflow_apply", "workflow_approve", "bash", "edit", "browser_execute"]) {
      expect(() => resolveProposalTool(denied)).toThrow(ToolDeniedError)
    }
  })

  test("the 12.4 read-only resolver does NOT gain proposal tools", () => {
    for (const tool of WORKFLOW_PROPOSAL_TOOLS) {
      expect(() => resolveTool(tool.id)).toThrow(ToolDeniedError)
    }
  })

  test("profiles: read-only excludes propose; proposal profile stays deny-by-default", () => {
    expect(profileAllows(MANAGED_WORKFLOW_PROFILE, "workflow_propose")).toBe(false)
    expect(profileAllows(PROPOSAL_WORKFLOW_PROFILE, "workflow_propose")).toBe(true)
    expect(PROPOSAL_WORKFLOW_PROFILE.tools["*"]).toBe(false)
    for (const denied of ["bash", "edit", "write", "webfetch", "browser_execute"]) {
      expect(profileAllows(PROPOSAL_WORKFLOW_PROFILE, denied)).toBe(false)
    }
  })

  test("the proposal profile markdown carries the identical tool map", () => {
    const markdown = readFileSync(join(import.meta.dir, "..", "profile", "managed-workflow-proposal.md"), "utf-8")
    expect(markdown).toContain('"*": false')
    for (const [toolId, enabled] of Object.entries(PROPOSAL_WORKFLOW_PROFILE.tools)) {
      if (toolId === "*") continue
      expect(enabled).toBe(true)
      expect(markdown).toContain(`${toolId}: true`)
    }
    expect(markdown).not.toContain("apply: true")
    expect(markdown).not.toContain("approve: true")
  })
})
