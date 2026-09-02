// Wire-contract tests for the managed authoring engine surface (serve.ts):
// exactly what the control plane's KoraCodeEngineClient expects, plus the
// engine-side epoch fence, idempotent resubmits, restart statelessness, and
// the zero-outbound guarantee.

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ENGINE_VERSION, WorkflowServe } from "../src/serve"

const AUTH = { authorization: `Bearer ${"t".repeat(32)}` }

function engine() {
  return new WorkflowServe({ workspaceRoot: mkdtempSync(join(tmpdir(), "kcw-serve-")) })
}

function req(method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH): Request {
  return new Request(`http://engine.test${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function eventsFor(serve: WorkflowServe, sessionId: string, turnId: string): Promise<{ kind: string; seq: number; payload: Record<string, unknown> }[]> {
  // Turns execute in the background — poll a few microtask ticks.
  for (let attempt = 0; attempt < 50; attempt++) {
    const res = await serve.fetch(req("GET", `/sessions/${sessionId}/events?turn_id=${turnId}&cursor=0`))
    const data = (await res.json()) as { events: { kind: string; seq: number; payload: Record<string, unknown> }[] }
    if (data.events.some((e) => e.kind.startsWith("turn_") && e.kind !== "turn_accepted")) return data.events
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const res = await serve.fetch(req("GET", `/sessions/${sessionId}/events?turn_id=${turnId}&cursor=0`))
  return ((await res.json()) as { events: { kind: string; seq: number; payload: Record<string, unknown> }[] }).events
}

async function createSession(serve: WorkflowServe): Promise<string> {
  const response = await serve.fetch(
    req("POST", "/sessions", {
      product_session_id: "ps-1",
      agent_id: "agent-1",
      protocol_version: "v1",
      profile: "managed-workflow",
    }),
  )
  expect(response.status).toBe(200)
  const data = (await response.json()) as { session_id: string; engine_version: string }
  expect(data.engine_version).toBe(ENGINE_VERSION)
  return data.session_id
}

describe("health and auth", () => {
  test("health is unauthenticated and reports the protocol range", async () => {
    const response = await engine().fetch(req("GET", "/health", undefined, {}))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, string>
    expect(body["protocol_min"]).toBe("v1")
    expect(body["protocol_max"]).toBe("v1")
  })

  test("every other route requires a bearer token", async () => {
    const serve = engine()
    for (const request of [
      req("POST", "/sessions", {}, {}),
      req("GET", "/sessions/x/events?turn_id=t&cursor=0", undefined, {}),
      req("DELETE", "/sessions/x", undefined, {}),
    ]) {
      expect((await serve.fetch(request)).status).toBe(401)
    }
  })
})

describe("session contract", () => {
  test("rejects unsupported protocols and foreign profiles", async () => {
    const serve = engine()
    const wrongProtocol = await serve.fetch(
      req("POST", "/sessions", { product_session_id: "p", agent_id: "a", protocol_version: "v2", profile: "managed-workflow" }),
    )
    expect(wrongProtocol.status).toBe(422)
    const wrongProfile = await serve.fetch(
      req("POST", "/sessions", { product_session_id: "p", agent_id: "a", protocol_version: "v1", profile: "build" }),
    )
    expect(wrongProfile.status).toBe(422)
  })

  test("turn lifecycle: accepted → completed events after the cursor", async () => {
    const serve = engine()
    const sessionId = await createSession(serve)
    const submit = await serve.fetch(
      req("POST", `/sessions/${sessionId}/turns`, {
        turn_id: "turn-1",
        epoch: 1,
        content: "what does this workflow do?",
        history: [{ role: "user", content: "earlier question" }],
      }),
    )
    expect(submit.status).toBe(200)
    const allEvents = await eventsFor(serve, sessionId, "turn-1")
    expect(allEvents.map((event) => event.kind)).toEqual(["turn_accepted", "turn_completed"])
    const terminal = allEvents.at(-1)!
    expect(String(terminal.payload["reply"])).toContain("[drill-responder]")
    // Cursor resume: nothing new after the last seq.
    const resumed = await serve.fetch(req("GET", `/sessions/${sessionId}/events?turn_id=turn-1&cursor=${terminal.seq}`))
    expect(((await resumed.json()) as { events: unknown[] }).events).toEqual([])
  })

  test("resubmitting the same turn id replays without duplicate events", async () => {
    const serve = engine()
    const sessionId = await createSession(serve)
    const submit = { turn_id: "turn-1", epoch: 1, content: "q", history: [] }
    const first = (await (await serve.fetch(req("POST", `/sessions/${sessionId}/turns`, submit))).json()) as {
      remote_turn_id: string
    }
    const replay = (await (await serve.fetch(req("POST", `/sessions/${sessionId}/turns`, submit))).json()) as {
      remote_turn_id: string
      replayed: boolean
    }
    expect(replay.remote_turn_id).toBe(first.remote_turn_id)
    expect(replay.replayed).toBe(true)
    const allEvents = await eventsFor(serve, sessionId, "turn-1")
    expect(allEvents.length).toBe(2) // accepted + completed, once
  })

  test("a stale epoch is refused 409 before any work happens", async () => {
    const serve = engine()
    const sessionId = await createSession(serve)
    await serve.fetch(req("POST", `/sessions/${sessionId}/turns`, { turn_id: "t-new", epoch: 5, content: "x", history: [] }))
    const stale = await serve.fetch(
      req("POST", `/sessions/${sessionId}/turns`, { turn_id: "t-stale", epoch: 3, content: "x", history: [] }),
    )
    expect(stale.status).toBe(409)
    const events = (await (
      await serve.fetch(req("GET", `/sessions/${sessionId}/events?turn_id=t-stale&cursor=0`))
    ).json()) as { events: unknown[] }
    expect(events.events).toEqual([]) // the fence stopped it before any event
  })

  test("dispose forgets the session and a NEW process knows nothing (restart statelessness)", async () => {
    const serve = engine()
    const sessionId = await createSession(serve)
    expect((await serve.fetch(req("DELETE", `/sessions/${sessionId}`))).status).toBe(200)
    expect((await serve.fetch(req("GET", `/sessions/${sessionId}/events?turn_id=t&cursor=0`))).status).toBe(404)
    // A fresh instance (= restarted container) has no memory of any session:
    // recovery is the control plane's job, from product history only.
    const restarted = engine()
    expect((await restarted.fetch(req("GET", `/sessions/${sessionId}/events?turn_id=t&cursor=0`))).status).toBe(404)
    expect(restarted.sessionCount()).toBe(0)
  })
})

describe("zero-outbound and profile guarantees", () => {
  test("serve.ts itself performs no outbound network calls; the model responder is pinned", () => {
    // serve.ts stays zero-outbound: the ONLY network surface is the inbound
    // handler; model calls live in llm-responder behind the egress policy.
    const serveSource = readFileSync(join(import.meta.dir, "..", "src", "serve.ts"), "utf-8")
    expect(serveSource).not.toMatch(/\bawait fetch\(|[^.\w]fetch\(["'`]|globalThis\.fetch|Bun\.fetch/)
    expect(serveSource).not.toMatch(/node:https?|XMLHttpRequest|WebSocket|axios|pinnedFetch/)
    expect(serveSource).not.toContain('from "./client"')
    expect(serveSource).not.toContain('from "./egress"')
    // serve-main wires the responder from env but never fetches directly.
    const mainSource = readFileSync(join(import.meta.dir, "..", "src", "serve-main.ts"), "utf-8")
    expect(mainSource).not.toMatch(/\bawait fetch\(|[^.\w]fetch\(["'`]/)
    expect(mainSource).toContain("policyFromEnv()")
    // llm-responder asserts the allowlist before every model call and routes
    // gateway calls through the pinned client.
    const responderSource = readFileSync(join(import.meta.dir, "..", "src", "llm-responder.ts"), "utf-8")
    expect(responderSource).toContain("assertAllowedUrl(url, this.options.policy)")
    expect(responderSource).not.toMatch(/fetch\(["'`]http/)
  })

  test("the engine serves under the deny-by-default managed profile", () => {
    const profile = engine().profile()
    expect(profile.name).toBe("managed-workflow")
    expect(profile.tools["*"]).toBe(false)
  })
})
