// Kora control-plane client — Phase 12.4 step 6, extended in 12.6 (proposals),
// 12.8 step 4 (scoped run tools), and 12.8 step 7 (request-only authorizations).
//
// Mirrors the mounted gateway surface exactly (workflows/backend/kora_gateway/
// router.py prefix /internal/kora/v1): head, revisions, versions, run status,
// run events by cursor, artifact manifest, proposal validate/propose/status,
// the run lifecycle (start/list/resource/controls/inputs/capabilities), and
// authorization request/readback. There is NO definition-mutating method —
// no publish, restore, schedule, set-live, approve, or apply — so a
// prompt-injected "publish this" has nothing to invoke. Run start/control
// only act on the SAVED definition the control plane resolves server-side;
// an authorization is a REQUEST a human must grant in the product (grant/
// deny/revoke exist neither on the gateway nor here); and the gateway
// independently scopes every call.

import { assertAllowedUrl, pinnedFetch, type EgressPolicy } from "./egress"

const GATEWAY_PREFIX = "/internal/kora/v1"
const MAX_RESPONSE_BYTES = 1_000_000
const MAX_ERROR_DETAIL_CHARS = 300

/** Gateway error details arrive as FastAPI `{detail: {code, message, ...}}`
 * (or a bare string detail); the code is what the model must see, e.g.
 * NO_PUBLISHED_VERSION when a run is started against an unpublished workflow,
 * or AUTHORIZATION_SUBJECT_NOOP when there is nothing to authorize. Typed
 * errors may carry further keys (e.g. `supported`), kept in `extra`. */
export interface GatewayErrorDetail {
  readonly code?: string
  readonly message: string
  readonly extra?: Record<string, unknown>
}

function parseErrorDetail(text: string): GatewayErrorDetail | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const body = parsed as Record<string, unknown>
  const detail = "detail" in body ? body["detail"] : body
  if (typeof detail === "string") return { message: detail.slice(0, MAX_ERROR_DETAIL_CHARS) }
  if (typeof detail !== "object" || detail === null) return undefined
  const record = detail as Record<string, unknown>
  const code = typeof record["code"] === "string" ? record["code"] : undefined
  const message = typeof record["message"] === "string" ? record["message"] : undefined
  if (code === undefined && message === undefined) return undefined
  const extra: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (key !== "code" && key !== "message") extra[key] = value
  }
  return {
    ...(code === undefined ? {} : { code }),
    message: (message ?? "").slice(0, MAX_ERROR_DETAIL_CHARS),
    ...(Object.keys(extra).length ? { extra } : {}),
  }
}

export class ControlPlaneError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Gateway error code (`{code, message}` detail), when the body carried one. */
    readonly code?: string,
    /** Gateway error message text, when the body carried one. */
    readonly detail?: string,
    /** Any further keys of a typed error detail (e.g. `supported` on
     * AUTHORIZATION_SUBJECT_UNSUPPORTED), so the model can act on them. */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message)
    this.name = "ControlPlaneError"
  }

  /** Build from a non-2xx body: the message keeps the historical
   * `gateway returned <status>` prefix and appends `(CODE: message)` when the
   * body is a `{code, message}` detail, so callers can still match the prefix. */
  static fromResponse(status: number, text: string): ControlPlaneError {
    const detail = parseErrorDetail(text)
    const suffix = detail ? ` (${detail.code ?? "error"}: ${detail.message})` : ""
    return new ControlPlaneError(status, `gateway returned ${status}${suffix}`, detail?.code, detail?.message, detail?.extra)
  }
}

// ---- Phase 12.8 step 4: run lifecycle request bodies (wire contract) ----

export type RunSource = "published" | "version" | "draft_snapshot"
export type RunControlCommand = "pause" | "resume" | "cancel"

export interface RunStartBody {
  /** Required: the gateway replays the same run for a repeated key. */
  readonly idempotency_key: string
  /** Defaults to 'published' server-side. */
  readonly source?: RunSource
  readonly version_number?: number
  readonly variable_values?: Record<string, unknown>
  readonly profile_id?: string
  readonly profile_pool_id?: string
  /** Authoring turn that started the run, for audit linkage. */
  readonly turn_id?: string
}

export interface RunControlBody {
  readonly command: RunControlCommand
  readonly command_id: string
  readonly expected_state?: string
}

export interface RunInputBody {
  readonly input_id: string
  /** Must match the run resource's declared waiting_request.request_id. */
  readonly request_id: string
  readonly payload: unknown
  readonly expected_state?: string
}

export interface RunListPage {
  readonly cursor?: string
  readonly limit?: number
}

// ---- Phase 12.8 step 7: request-only authorizations (wire contract) ----
//
// The model supplies only the subject kind and its reference; the server
// computes the binding, classifies the risk, and a HUMAN grants it in the
// product. Nothing here can grant, deny, revoke, or perform the operation.

export type AuthorizationSubjectKind =
  | "workflow.publish"
  | "workflow.restore"
  | "workflow.set_live"
  | "schedule.update"
  | "schedule.delete"
  | "batch.cancel"

export interface AuthorizationRequestBody {
  readonly subject_kind: AuthorizationSubjectKind
  /** Per-kind reference: workflow.* {agent_id, ...}, schedule.* {schedule_id, ...}, batch.cancel {batch_id}. */
  readonly subject_ref: Record<string, unknown>
  /** Required: an equivalent repeat replays the same authorization. */
  readonly idempotency_key: string
  readonly rationale?: string
  /** Engine-set at dispatch (never model-supplied): the requesting authoring turn. */
  readonly turn_id?: string
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
      if (!response.ok) throw ControlPlaneError.fromResponse(response.status, text)
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
    return this.request(`/runs/${encodeURIComponent(runId)}/events`, { after: afterSeq, limit })
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

  // ---- Phase 12.8 step 4: scoped run lifecycle ----
  // These act on runs of the SAVED definition (published by default) and on
  // a run's own declared controls/inputs. They never touch the definition:
  // publish/restore/schedule/approve/apply still do not exist on this client.

  /** POST /workflows/{agent_id}/runs → 202 RunResource. */
  startRun(agentId: string, body: RunStartBody) {
    return this.request(`/workflows/${encodeURIComponent(agentId)}/runs`, undefined, body, "POST")
  }

  /** GET /workflows/{agent_id}/runs?cursor=&limit= → {items, next_cursor}. */
  listRuns(agentId: string, page: RunListPage = {}) {
    const params: Record<string, string | number> = {}
    if (page.cursor !== undefined) params["cursor"] = page.cursor
    if (page.limit !== undefined) params["limit"] = page.limit
    return this.request(`/workflows/${encodeURIComponent(agentId)}/runs`, params)
  }

  /** GET /runs/{run_id}/resource → RunResource (status, legal_controls, waiting_request, links). */
  runResource(runId: string) {
    return this.request(`/runs/${encodeURIComponent(runId)}/resource`)
  }

  /** POST /runs/{run_id}/controls → 202 ControlResult (accepted ≠ effective). */
  controlRun(runId: string, body: RunControlBody) {
    return this.request(`/runs/${encodeURIComponent(runId)}/controls`, undefined, body, "POST")
  }

  /** POST /runs/{run_id}/inputs → 202 InputAccepted; answers a declared waiting_request only. */
  submitRunInput(runId: string, body: RunInputBody) {
    return this.request(`/runs/${encodeURIComponent(runId)}/inputs`, undefined, body, "POST")
  }

  /** GET /runs/{run_id}/capabilities → backend capability declaration. */
  runCapabilities(runId: string) {
    return this.request(`/runs/${encodeURIComponent(runId)}/capabilities`)
  }

  // ---- Phase 12.8 step 7: request-only authorizations ----
  // Request and read back. There is deliberately no grant/deny/revoke: a
  // human decides in the product's Authorizations panel, and the operation
  // itself runs only when that grant is consumed server-side.

  /** POST /authorizations → 202 authorization view (status starts 'requested'). */
  requestAuthorization(body: AuthorizationRequestBody) {
    return this.request(`/authorizations`, undefined, body, "POST")
  }

  /** GET /authorizations/{authorization_id} → the same view (status readback). */
  getAuthorization(authorizationId: string) {
    return this.request(`/authorizations/${encodeURIComponent(authorizationId)}`)
  }
}
