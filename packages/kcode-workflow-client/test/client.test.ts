// Phase 12.4 client contract tests: gateway paths, auth header shape,
// cursors, redirect refusal, and size budgets — no socket ever opens.

import { describe, expect, test } from "bun:test"

import { ControlPlaneError, WorkflowControlPlaneClient } from "../src/client"
import { EgressDeniedError } from "../src/egress"

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

describe("WorkflowControlPlaneClient", () => {
  test("refuses construction against a non-allowlisted base URL", () => {
    expect(
      () =>
        new WorkflowControlPlaneClient({
          baseUrl: "https://other.example",
          tokenProvider: () => "t",
          policy: POLICY,
        }),
    ).toThrow(EgressDeniedError)
  })

  test("hits the exact mounted gateway paths with bearer + request id", async () => {
    const { client, seen } = clientWith(() => Response.json({ ok: true }))
    await client.workflowHead("agent-1")
    expect(seen.url).toBe("https://kora.internal:8000/internal/kora/v1/workflows/agent-1/head")
    const headers = new Headers(seen.init?.headers)
    expect(headers.get("authorization")).toBe("Bearer short-lived-token")
    expect(headers.get("x-request-id")).toMatch(/[0-9a-f-]{36}/)

    await client.runEvents("run-9", 41, 100)
    expect(seen.url).toBe("https://kora.internal:8000/internal/kora/v1/runs/run-9/events?after_seq=41&limit=100")

    await client.runArtifacts("run-9")
    expect(seen.url).toBe("https://kora.internal:8000/internal/kora/v1/runs/run-9/artifacts")
  })

  test("a redirect answer is refused, not followed", async () => {
    const { client } = clientWith(
      () => new Response(null, { status: 307, headers: { location: "https://evil.example" } }),
    )
    await expect(client.workflowHead("a")).rejects.toThrow(ControlPlaneError)
  })

  test("gateway errors surface with their status", async () => {
    const { client } = clientWith(() => new Response("denied", { status: 403 }))
    await expect(client.runStatus("r")).rejects.toThrow("gateway returned 403")
  })
})
