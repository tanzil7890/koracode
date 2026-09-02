// Managed authoring engine HTTP surface — Phase 12.4 "minimal server/tool
// integration in new files" + the live-drill target for steps 5/8/11/14.
//
// Implements EXACTLY the wire contract the Kora control plane's
// KoraCodeEngineClient speaks:
//
//   GET    /health                          → protocol/version (no auth)
//   POST   /sessions                        → open a disposable session
//   POST   /sessions/:sid/turns            → submit one turn (idempotent)
//   GET    /sessions/:sid/events           → events after ?cursor=
//   POST   /sessions/:sid/turns/:tid/cancel
//   DELETE /sessions/:sid
//
// Design constraints, enforced here and asserted by tests:
//   * ZERO outbound network calls — this module never fetches anything; the
//     model integration is a pluggable TurnResponder, and the default is a
//     deterministic drill responder that answers from the turn input alone.
//   * Stateless by product contract: sessions live in memory + a disposable
//     workspace. A restart forgets everything — the control plane owns
//     history and rehydrates (Phase 12.4 step 10), which the drill proves.
//   * Epoch fencing engine-side too: a turn carrying an epoch older than the
//     session's current epoch is refused 409 before any work happens.

import { SessionBindingAdapter, type ProductHistoryMessage, type SessionBinding } from "./binding"
import { MANAGED_WORKFLOW_PROFILE } from "./profile"

export const ENGINE_VERSION = "0.1.0-drill"
export const PROTOCOL_MIN = "v1"
export const PROTOCOL_MAX = "v1"
const MAX_BODY_BYTES = 1_000_000

export interface TurnCallback {
  /** Kora gateway base URL the engine may call back into. */
  readonly gatewayUrl: string
  readonly agentId: string
  /** One-use service tokens, one per gateway call (the gateway's jti replay
   * protection makes a single multi-call token impossible by design). */
  readonly tokens: readonly string[]
  /** Control-plane feature grants for this turn ('propose', 'run'), parsed
   * from body.callback.features. Absent means the legacy grant ['propose'];
   * an explicit empty list means reads only. The gateway enforces the same
   * scopes server-side — this only decides which tools the model even sees. */
  readonly features?: readonly string[]
}

/** What a callback without an explicit features list is granted (12.6/12.7
 * control planes never sent one and always expected the proposal tools). */
export const DEFAULT_CALLBACK_FEATURES: readonly string[] = ["propose"]

/** The effective feature grants for a turn — the single place the legacy
 * default is applied, so the responder and the trace agree. */
export function callbackFeatures(callback: TurnCallback | undefined): readonly string[] {
  return callback?.features ?? DEFAULT_CALLBACK_FEATURES
}

export interface TurnRequest {
  readonly turnId: string
  readonly epoch: number
  readonly content: string
  readonly history: readonly ProductHistoryMessage[]
  readonly callback?: TurnCallback
}

export interface TurnResponder {
  /** Short label for logs ("drill", "llm") so an operator reading the
   * container log can tell which responder answered each turn. */
  readonly name?: string
  respond(request: TurnRequest): Promise<{ reply: string; totalTokens: number }>
}

/** One structured log event: the engine's counterpart to the control plane's
 * `authoring.engine` lines. Never carries turn content. */
export type EngineTrace = (event: string, fields: Record<string, unknown>) => void

/** Deterministic, network-free responder used by drills and tests. A real
 * model responder plugs in behind the same interface without touching the
 * wire surface. Clearly labels itself so a drill answer can never be
 * mistaken for an evaluated model answer. */
export class DrillResponder implements TurnResponder {
  readonly name = "drill"

  async respond(request: TurnRequest): Promise<{ reply: string; totalTokens: number }> {
    const reply =
      `[drill-responder] read-only acknowledgement for turn ${request.turnId}: ` +
      `received ${request.content.length} chars with ${request.history.length} history messages.`
    return { reply, totalTokens: request.content.length + reply.length }
  }
}

interface EventRecord {
  event_id: string
  seq: number
  kind: string
  turn_id: string
  payload: Record<string, unknown>
}

interface TurnRecord {
  remoteTurnId: string
  epoch: number
  state: "accepted" | "completed" | "cancelled" | "failed"
}

interface SessionRecord {
  binding: SessionBinding
  productSessionId: string
  agentId: string
  protocolVersion: string
  epoch: number
  nextSeq: number
  events: EventRecord[]
  turns: Map<string, TurnRecord>
}

export interface WorkflowServeOptions {
  readonly workspaceRoot: string
  readonly sessionTtlMs?: number
  readonly responder?: TurnResponder
  /** Structured per-turn log sink; silent when omitted (tests). */
  readonly trace?: EngineTrace
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

export class WorkflowServe {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly bindings: SessionBindingAdapter
  private readonly responder: TurnResponder
  private readonly trace: EngineTrace

  constructor(private readonly options: WorkflowServeOptions) {
    this.bindings = new SessionBindingAdapter({
      workspaceRoot: options.workspaceRoot,
      sessionTtlMs: options.sessionTtlMs ?? 3_600_000,
      maxHistoryMessages: 40,
      maxHistoryBytes: 200_000,
    })
    this.responder = options.responder ?? new DrillResponder()
    this.trace = options.trace ?? (() => {})
  }

  private get responderName(): string {
    return this.responder.name ?? "custom"
  }

  sessionCount(): number {
    return this.sessions.size
  }

  /** The profile this engine serves under — deny-by-default, exported so the
   * drill can assert the running process carries no other surface. */
  profile() {
    return MANAGED_WORKFLOW_PROFILE
  }

  private emit(session: SessionRecord, turnId: string, kind: string, payload: Record<string, unknown>): void {
    session.events.push({
      event_id: `${turnId}:${session.nextSeq}`,
      seq: session.nextSeq,
      kind,
      turn_id: turnId,
      payload,
    })
    session.nextSeq += 1
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const parts = url.pathname.split("/").filter(Boolean)

    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { engine_version: ENGINE_VERSION, protocol_min: PROTOCOL_MIN, protocol_max: PROTOCOL_MAX })
    }

    // Everything else requires the control plane's bearer token. Full
    // signature verification happens at the Kora gateway on every callback;
    // engine-side presence/shape is defense in depth for the drill surface.
    const authorization = request.headers.get("authorization") ?? ""
    if (!authorization.startsWith("Bearer ") || authorization.length < 24) {
      return json(401, { error: "missing bearer token" })
    }

    try {
      if (request.method === "POST" && parts.length === 1 && parts[0] === "sessions") {
        return await this.createSession(request)
      }
      if (parts[0] === "sessions" && parts.length >= 2) {
        const session = this.sessions.get(parts[1]!)
        if (!session) return json(404, { error: "unknown session" })
        if (request.method === "POST" && parts.length === 3 && parts[2] === "turns") {
          return await this.submitTurn(session, request)
        }
        if (request.method === "GET" && parts.length === 3 && parts[2] === "events") {
          const turnId = url.searchParams.get("turn_id") ?? ""
          const cursor = Number(url.searchParams.get("cursor") ?? 0)
          const events = session.events.filter((event) => event.turn_id === turnId && event.seq > cursor)
          return json(200, { events })
        }
        if (request.method === "POST" && parts.length === 5 && parts[2] === "turns" && parts[4] === "cancel") {
          return this.cancelTurn(session, parts[3]!)
        }
        if (request.method === "DELETE" && parts.length === 2) {
          this.bindings.dispose(session.binding.sessionId)
          this.sessions.delete(parts[1]!)
          return json(200, { disposed: true })
        }
      }
      return json(404, { error: "unknown route" })
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.name : "bad request" })
    }
  }

  private async body(request: Request): Promise<Record<string, unknown>> {
    const text = await request.text()
    if (text.length > MAX_BODY_BYTES) throw new Error("PayloadTooLarge")
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null) throw new Error("BadPayload")
    return parsed as Record<string, unknown>
  }

  private async createSession(request: Request): Promise<Response> {
    const body = await this.body(request)
    const protocolVersion = String(body["protocol_version"] ?? "")
    if (protocolVersion !== "v1") {
      return json(422, { error: `unsupported protocol ${protocolVersion}; supported ${PROTOCOL_MIN}..${PROTOCOL_MAX}` })
    }
    if (body["profile"] !== MANAGED_WORKFLOW_PROFILE.name) {
      return json(422, { error: "only the managed-workflow profile is served" })
    }
    const productSessionId = String(body["product_session_id"] ?? "")
    const agentId = String(body["agent_id"] ?? "")
    if (!productSessionId || !agentId) return json(422, { error: "product_session_id and agent_id are required" })
    const binding = this.bindings.create(productSessionId, agentId, 0)
    this.sessions.set(binding.sessionId, {
      binding,
      productSessionId,
      agentId,
      protocolVersion,
      epoch: 0,
      nextSeq: 1,
      events: [],
      turns: new Map(),
    })
    return json(200, { session_id: binding.sessionId, engine_version: ENGINE_VERSION })
  }

  private async submitTurn(session: SessionRecord, request: Request): Promise<Response> {
    const body = await this.body(request)
    const turnId = String(body["turn_id"] ?? "")
    const epoch = Number(body["epoch"] ?? 0)
    if (!turnId) return json(422, { error: "turn_id is required" })

    const existing = session.turns.get(turnId)
    if (existing) {
      // Remote idempotency (Phase 12.4 §10.1): a resubmit after a lost ack
      // repeats nothing — same remote turn, no duplicate events.
      this.trace("turn_replayed", { turn_id: turnId, remote_turn_id: existing.remoteTurnId, state: existing.state })
      return json(200, { remote_turn_id: existing.remoteTurnId, replayed: true })
    }
    if (epoch < session.epoch) {
      // Engine-side epoch fence: a revoked/stale binding cannot start work.
      this.trace("turn_refused", { turn_id: turnId, reason: "stale_epoch", epoch, session_epoch: session.epoch })
      return json(409, { error: "stale epoch", session_epoch: session.epoch })
    }
    session.epoch = epoch

    const historyRaw = Array.isArray(body["history"]) ? (body["history"] as ProductHistoryMessage[]) : []
    const history = this.bindings.rehydrate(historyRaw)
    const content = String(body["content"] ?? "")
    const callbackRaw = body["callback"] as Record<string, unknown> | undefined
    // features: only an array of strings counts; anything else is "absent"
    // and keeps the legacy ['propose'] grant (callbackFeatures applies it).
    const featuresRaw = callbackRaw?.["features"]
    const features = Array.isArray(featuresRaw)
      ? featuresRaw.filter((feature): feature is string => typeof feature === "string")
      : undefined
    const callback: TurnCallback | undefined =
      callbackRaw && typeof callbackRaw["gateway_url"] === "string"
        ? {
            gatewayUrl: String(callbackRaw["gateway_url"]),
            agentId: String(callbackRaw["agent_id"] ?? ""),
            tokens: Array.isArray(callbackRaw["tokens"]) ? (callbackRaw["tokens"] as string[]) : [],
            ...(features === undefined ? {} : { features }),
          }
        : undefined
    const remoteTurnId = `rt_${crypto.randomUUID()}`
    const record: TurnRecord = { remoteTurnId, epoch, state: "accepted" }
    session.turns.set(turnId, record)
    this.emit(session, turnId, "turn_accepted", { remote_turn_id: remoteTurnId, epoch })
    this.trace("turn_accepted", {
      turn_id: turnId,
      remote_turn_id: remoteTurnId,
      epoch,
      session: session.productSessionId,
      agent: session.agentId,
      responder: this.responderName,
      history_messages: history.length,
      callback_tokens: callback?.tokens.length ?? 0,
      callback_features: callback ? [...callbackFeatures(callback)] : [],
    })

    // The turn runs in the background — a model-backed responder takes tens
    // of seconds and the wire contract is submit-then-poll-events.
    void this.executeTurn(session, turnId, record, { turnId, epoch, content, history, callback })
    return json(200, { remote_turn_id: remoteTurnId, replayed: false })
  }

  private async executeTurn(
    session: SessionRecord,
    turnId: string,
    record: TurnRecord,
    request: TurnRequest,
  ): Promise<void> {
    const started = performance.now()
    try {
      const { reply, totalTokens } = await this.responder.respond(request)
      if (record.state === "accepted") {
        record.state = "completed"
        this.emit(session, turnId, "turn_completed", { reply, usage: { total_tokens: totalTokens } })
        this.trace("turn_completed", {
          turn_id: turnId,
          responder: this.responderName,
          duration_ms: Math.round(performance.now() - started),
          total_tokens: totalTokens,
          reply_chars: reply.length,
        })
      } else {
        this.trace("turn_result_dropped", { turn_id: turnId, responder: this.responderName, state: record.state })
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error"
      if (record.state === "accepted") {
        record.state = "failed"
        this.emit(session, turnId, "turn_failed", {
          error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "responder failed",
        })
      }
      this.trace("turn_failed", {
        turn_id: turnId,
        responder: this.responderName,
        duration_ms: Math.round(performance.now() - started),
        error: name,
      })
    }
  }

  private cancelTurn(session: SessionRecord, turnId: string): Response {
    const record = session.turns.get(turnId)
    if (!record) return json(404, { error: "unknown turn" })
    if (record.state === "accepted") {
      record.state = "cancelled"
      this.emit(session, turnId, "turn_cancelled", {})
      this.trace("turn_cancelled", { turn_id: turnId, responder: this.responderName })
    }
    return json(200, { state: record.state })
  }
}
