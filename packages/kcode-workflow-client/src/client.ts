// Read-only Kora control-plane client — Phase 12.4 step 6.
//
// Mirrors the mounted gateway surface exactly (workflows/backend/kora_gateway/
// router.ts prefix /internal/kora/v1): head, revisions, versions, run status,
// run events by cursor, artifact manifest. There is no mutation method to
// call, so a prompt-injected "publish this" has nothing to invoke.

import { assertAllowedUrl, pinnedFetch, type EgressPolicy } from "./egress"

const GATEWAY_PREFIX = "/internal/kora/v1"
const MAX_RESPONSE_BYTES = 1_000_000

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "ControlPlaneError"
  }
}

export interface WorkflowClientOptions {
  /** Kora control-plane base URL, e.g. https://kora.internal:8000 */
  readonly baseUrl: string
  /** Fresh short-lived service token per call — never a static credential. */
  readonly tokenProvider: () => string | Promise<string>
  readonly policy: EgressPolicy
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

export class WorkflowControlPlaneClient {
  constructor(private readonly options: WorkflowClientOptions) {
    assertAllowedUrl(options.baseUrl, options.policy)
  }

  private async request(
    path: string,
    params?: Record<string, string | number>,
    body?: unknown,
    method: "GET" | "POST" = "GET",
  ): Promise<unknown> {
    const url = new URL(`${GATEWAY_PREFIX}${path}`, this.options.baseUrl)
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value))
    const token = await this.options.tokenProvider()
    const doFetch = this.options.fetchImpl
      ? async (u: string, init?: RequestInit) => {
          assertAllowedUrl(u, this.options.policy)
          return this.options.fetchImpl!(u, { ...init, redirect: "manual" })
        }
      : (u: string, init?: RequestInit) => pinnedFetch(u, this.options.policy, init)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 10_000)
    try {
      const response = await doFetch(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          "x-request-id": crypto.randomUUID(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
      if (response.status >= 300 && response.status < 400) throw new ControlPlaneError(response.status, "redirect refused")
      const text = await response.text()
      if (text.length > MAX_RESPONSE_BYTES) throw new ControlPlaneError(response.status, "response exceeds size budget")
      if (!response.ok) throw new ControlPlaneError(response.status, `gateway returned ${response.status}`)
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
    }
  }

  workflowHead(agentId: string) {
    return this.request(`/workflows/${encodeURIComponent(agentId)}/head`)
  }

  workflowRevisions(agentId: string, limit = 20) {
    return this.request(`/workflows/${encodeURIComponent(agentId)}/revisions`, { limit })
  }

  workflowVersions(agentId: string, limit = 20) {
    return this.request(`/workflows/${encodeURIComponent(agentId)}/versions`, { limit })
  }

  runStatus(runId: string) {
    return this.request(`/runs/${encodeURIComponent(runId)}`)
  }

  runEvents(runId: string, afterSeq = 0, limit = 200) {
    return this.request(`/runs/${encodeURIComponent(runId)}/events`, { after_seq: afterSeq, limit })
  }

  runArtifacts(runId: string) {
    return this.request(`/runs/${encodeURIComponent(runId)}/artifacts`)
  }

  // ---- Phase 12.6: proposal-only authoring (validate/propose/get) ----
  // Approve and apply deliberately do not exist here: they are human product
  // operations, so this client cannot mutate canonical state even if asked.

  validateProposal(agentId: string, candidateGraph: Record<string, unknown>) {
    return this.request(
      `/workflows/${encodeURIComponent(agentId)}/proposals/validate`,
      undefined,
      { candidate_graph: candidateGraph },
      "POST",
    )
  }

  propose(
    agentId: string,
    proposal: {
      base_generation: number
      base_hash: string
      candidate_graph?: Record<string, unknown>
      patch_ops?: Record<string, unknown>[]
      idempotency_key: string
      turn_id?: string
      binding_id?: string
      epoch?: number
    },
  ) {
    return this.request(`/workflows/${encodeURIComponent(agentId)}/proposals`, undefined, proposal, "POST")
  }

  proposalStatus(agentId: string, changeSetId: string) {
    return this.request(
      `/workflows/${encodeURIComponent(agentId)}/proposals/${encodeURIComponent(changeSetId)}`,
    )
  }
}
