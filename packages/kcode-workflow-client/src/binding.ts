// Session binding / recovery adapter — Phase 12.4 steps 9/10/12.
//
// Maps ONE product authoring thread to ONE disposable engine session with a
// tenant-scoped workspace directory. Rehydration takes the policy-safe
// history the control plane sends — never local SQLite or any KoraCode-local
// state: after a restart the adapter rebuilds context purely from what Kora
// provides, which is the durability contract of the whole phase.

import { mkdirSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"

export interface ProductHistoryMessage {
  readonly role: "user" | "assistant"
  readonly content: string
}

export interface SessionBinding {
  readonly sessionId: string
  readonly productSessionId: string
  readonly tenantId: string
  readonly epoch: number
  readonly workspaceDir: string
  readonly createdAtMs: number
  readonly expiresAtMs: number
}

export interface BindingAdapterOptions {
  readonly workspaceRoot: string
  readonly sessionTtlMs: number
  readonly maxHistoryMessages: number
  readonly maxHistoryBytes: number
  readonly now?: () => number
}

export class SessionBindingAdapter {
  private readonly bindings = new Map<string, SessionBinding>()

  constructor(private readonly options: BindingAdapterOptions) {}

  /** One disposable session per (tenant, product session); a rebind bumps the
   * epoch and gets a FRESH workspace — nothing is shared across epochs. */
  create(productSessionId: string, tenantId: string, epoch: number): SessionBinding {
    const now = (this.options.now ?? Date.now)()
    const sessionId = `kcw_${crypto.randomUUID()}`
    const workspaceDir = join(this.options.workspaceRoot, sanitize(tenantId), `${sanitize(productSessionId)}-e${epoch}`)
    mkdirSync(workspaceDir, { recursive: true, mode: 0o700 })
    const binding: SessionBinding = {
      sessionId,
      productSessionId,
      tenantId,
      epoch,
      workspaceDir,
      createdAtMs: now,
      expiresAtMs: now + this.options.sessionTtlMs,
    }
    this.bindings.set(sessionId, binding)
    return binding
  }

  get(sessionId: string): SessionBinding | undefined {
    return this.bindings.get(sessionId)
  }

  /** Bounded rehydration from PRODUCT history only (step 10). */
  rehydrate(history: readonly ProductHistoryMessage[]): ProductHistoryMessage[] {
    let bounded = history.slice(-this.options.maxHistoryMessages)
    while (bounded.length > 0 && totalBytes(bounded) > this.options.maxHistoryBytes) {
      bounded = bounded.slice(1)
    }
    return [...bounded]
  }

  /** Dispose one session: forget the binding AND remove its workspace. */
  dispose(sessionId: string): void {
    const binding = this.bindings.get(sessionId)
    if (!binding) return
    this.bindings.delete(sessionId)
    if (existsSync(binding.workspaceDir)) rmSync(binding.workspaceDir, { recursive: true, force: true })
  }

  /** Reap expired sessions (step 12 cleanup/expiry proof). Returns count. */
  reapExpired(): number {
    const now = (this.options.now ?? Date.now)()
    let reaped = 0
    for (const [sessionId, binding] of this.bindings) {
      if (binding.expiresAtMs <= now) {
        this.dispose(sessionId)
        reaped += 1
      }
    }
    return reaped
  }

  activeCount(): number {
    return this.bindings.size
  }
}

function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)
}

function totalBytes(history: readonly ProductHistoryMessage[]): number {
  return history.reduce((sum, message) => sum + Buffer.byteLength(message.content, "utf-8"), 0)
}
