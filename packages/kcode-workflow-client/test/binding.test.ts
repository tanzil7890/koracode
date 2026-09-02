// Phase 12.4 binding tests: disposable sessions, tenant-separated
// workspaces, product-history-only rehydration, cleanup and expiry.

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { SessionBindingAdapter } from "../src/binding"

function adapter(nowRef: { value: number }, root = mkdtempSync(join(tmpdir(), "kcw-"))) {
  return new SessionBindingAdapter({
    workspaceRoot: root,
    sessionTtlMs: 1_000,
    maxHistoryMessages: 3,
    maxHistoryBytes: 64,
    now: () => nowRef.value,
  })
}

describe("SessionBindingAdapter", () => {
  test("tenants and epochs never share a workspace (step 12)", () => {
    const now = { value: 0 }
    const bindings = adapter(now)
    const a = bindings.create("session-1", "tenant-a", 1)
    const b = bindings.create("session-1", "tenant-b", 1)
    const a2 = bindings.create("session-1", "tenant-a", 2)
    expect(a.workspaceDir).not.toBe(b.workspaceDir)
    expect(a.workspaceDir).not.toBe(a2.workspaceDir)
    expect(a.workspaceDir).toContain("tenant-a")
    expect(b.workspaceDir).toContain("tenant-b")
    expect(existsSync(a.workspaceDir)).toBe(true)
  })

  test("workspace paths cannot be escaped through hostile ids", () => {
    const now = { value: 0 }
    const root = mkdtempSync(join(tmpdir(), "kcw-"))
    const bindings = adapter(now, root)
    const hostile = bindings.create("../../etc", "tenant/../root", 1)
    expect(hostile.workspaceDir.startsWith(root)).toBe(true)
    expect(hostile.workspaceDir).not.toContain("..")
  })

  test("rehydration is bounded and uses ONLY the provided product history (step 10)", () => {
    const now = { value: 0 }
    const bindings = adapter(now)
    const history = Array.from({ length: 10 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `message number ${index} `.repeat(2),
    }))
    const rehydrated = bindings.rehydrate(history)
    expect(rehydrated.length).toBeLessThanOrEqual(3)
    expect(rehydrated.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(64)
    // Latest context survives the bounding — recovery keeps the tail.
    expect(rehydrated.at(-1)?.content).toContain("message number 9")
  })

  test("dispose removes the workspace; reap enforces expiry (step 12)", () => {
    const now = { value: 0 }
    const bindings = adapter(now)
    const binding = bindings.create("session-1", "tenant-a", 1)
    expect(existsSync(binding.workspaceDir)).toBe(true)
    bindings.dispose(binding.sessionId)
    expect(existsSync(binding.workspaceDir)).toBe(false)
    expect(bindings.activeCount()).toBe(0)

    const expiring = bindings.create("session-2", "tenant-a", 1)
    now.value = 5_000 // past the 1s TTL
    expect(bindings.reapExpired()).toBe(1)
    expect(existsSync(expiring.workspaceDir)).toBe(false)
  })
})
