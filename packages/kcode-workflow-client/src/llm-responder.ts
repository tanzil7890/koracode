// Model-backed TurnResponder — Phase 12.7 steps 6–7 (the live-trial engine),
// extended in 12.8 step 4 with the feature-scoped run tools.
//
// An OpenAI-compatible tool-calling loop over EXACTLY the tools the turn's
// control-plane feature grants unlock: the read tools always, the proposal
// tools with 'propose', the run tools with 'run' (resolveFeatureTool is the
// only lookup, so an injected request for bash/edit/apply — or a run tool on
// a propose-only turn — cannot execute). Every network call goes through the
// pinned egress policy: the model origin and the Kora gateway, nothing else.
// Gateway calls consume one-use callback tokens the control plane minted for
// this turn; when they run out, the loop stops — a hard, control-plane-owned
// tool budget.
//
// Engine quality (v7): the responder never sends an off-contract candidate.
// A propose is intercepted and run through normalize → local lint → gateway
// validate; only a candidate the control plane accepts is proposed, so a
// rejected change set can no longer be a turn's outcome. Anything the engine
// must not guess comes back to the model as precise, code-keyed guidance.
//
// Runs (12.8 step 4): a run acts on the SAVED definition and continues
// independently of the chat. The responder pins the agent, links the run to
// the turn, and traces start/control/wait — it never interprets a control as
// done: the gateway's effective_status is passed to the model literally.
//
// Authorizations (12.8 step 7): a protected operation is only ever REQUESTED.
// The responder pins workflow.* subjects to the turn's agent, links the
// request to the turn, traces it, and hands the model the gateway's view plus
// a literal status reminder — a human grants it in the product, and only
// 'consumed' means the operation happened.

import {
  PatchError,
  applyPatchOps,
  guidanceFor,
  lintCandidate,
  normalizeCandidate,
  type JsonObject,
  type RepairNote,
} from "./candidate-repair"
import { ControlPlaneError, WorkflowControlPlaneClient } from "./client"
import { assertAllowedUrl, type EgressPolicy } from "./egress"
import {
  AUTHORIZE_WORKFLOW_PROFILE,
  MANAGED_WORKFLOW_PROFILE,
  PROPOSAL_WORKFLOW_PROFILE,
  RUN_WORKFLOW_PROFILE,
} from "./profile"
import { callbackFeatures, type EngineTrace, type TurnRequest, type TurnResponder } from "./serve"
import {
  RUN_ID_REQUIRED_CODE,
  ToolDeniedError,
  isAuthorizationToolId,
  resolveFeatureTool,
  toolsForFeatures,
  type RunWaitResult,
} from "./tools"

const MAX_TOOL_CALLS = 10
const MAX_MODEL_ROUNDS = 14
const TOOL_RESULT_CAP = 8_000

export interface LLMResponderOptions {
  readonly apiKey: string
  readonly model: string
  /** e.g. https://api.openai.com — must be on the egress policy. */
  readonly modelOrigin: string
  readonly policy: EgressPolicy
  readonly fetchImpl?: typeof fetch
  /** Structured log sink for proposal outcomes and denied tools; silent when omitted. */
  readonly trace?: EngineTrace
  /** Sleep used by workflow_run_wait between polls; injectable for tests. */
  readonly sleep?: (ms: number) => Promise<void>
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

interface HeadSnapshot {
  readonly generation: number
  readonly content_hash: string
  readonly graph: JsonObject
}

/** Per-turn proposal state: the head the candidate derives from and whether
 * a change set was actually created (drives the one-shot completion nudge). */
interface TurnState {
  head?: HeadSnapshot
  attempts: number
  proposed: boolean
  nudged: boolean
  /** Runs started this turn (12.8) — reported in the loop summary trace. */
  runsStarted: number
  /** Confirmation-gated starts this turn: the gateway answered with a
   * 'run.start' authorization request instead of a run (12.8 step 7). */
  runsRequested: number
  /** Authorization requests created this turn (12.8 step 7). */
  authorizationsRequested: number
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function asHead(output: unknown): HeadSnapshot | undefined {
  if (!isObject(output) || !isObject(output["graph"])) return undefined
  return {
    generation: Number(output["generation"] ?? 0),
    content_hash: String(output["content_hash"] ?? ""),
    graph: output["graph"],
  }
}

export const SCHEMA_HINT =
  "Workflow graph contract (v3): top-level {version:3, name, entry:<node id>, variables:[], nodes:[], edges:[]}. " +
  "Node types: agent {id,type:'agent',name,instruction,position:{x,y}, optional model/capabilities/input_schema/script:{filepath,failure_action}/screen}; " +
  "condition {id,type:'condition',name,check:{kind:'url_contains'|'text_present'|'element_exists',value},position} with EXACTLY one 'true' and one 'false' outgoing edge (never success/error); " +
  "loop {id,type:'loop',name,items_variable,item_instruction,max_iterations,position}; " +
  "subworkflow {id,type:'subworkflow',name,target_agent_id,input_mapping:{childVar:'literal or {{.VAR}}'},position}; " +
  "terminals {id,type:'success'|'error',position}. Edges: {id,from,to,when:'success'|'error'|'true'|'false'}. " +
  "Every agent/loop/subworkflow node must route BOTH success and error somewhere; the entry must be an agent/loop/subworkflow node. " +
  "Secret values are referenced as ##NAME## tokens, never literals. " +
  "INVARIANTS: keep ALL top-level fields (version,name,entry,variables,nodes,edges); variables entries are OBJECTS " +
  "{name,description?,secret?}, never bare strings; NEVER rename or drop existing node/edge ids unless the task demands it " +
  "(edges must always reference existing node ids); the ONLY valid capabilities are 'browser', 'screen.snapshot', " +
  "'screen.computer', 'scripts' — never invent others; input_schema is plain JSON Schema (type/properties/required) " +
  "with no external references, and EVERY property in an input_schema MUST carry an 'x-source' annotation shaped " +
  "{\"from\":\"run\",\"pointer\":\"/<property name>\"} — exactly those two keys, pointer starting with '/'. " +
  "Do NOT add an input_schema unless the task asks for one. " +
  "Every {{.VAR}} template you use in any instruction or value MUST be declared in top-level variables as an object " +
  "{name:'VAR'} (e.g. using {{.NAME}} requires variables:[{name:'NAME'}]). " +
  "A node's fast-path script is the SINGULAR field script:{filepath:'./scripts/x.js',failure_action:'fallback_to_ai'} " +
  "ON THE TARGET NODE — never a plural scripts field and never a top-level scripts list. " +
  "Add EXACTLY the fields the task asks for; do not add OTHER unrequested optional fields " +
  "(input_schema, capabilities, script, screen, model). EXCEPTION — ALWAYS REQUIRED, never 'volunteering': " +
  "declaring a top-level variables entry {name:'X'} for EVERY {{.X}} template you use anywhere in the graph. " +
  "EDGE CARDINALITY: every task node may have AT MOST ONE outgoing 'success' edge and AT MOST ONE outgoing 'error' edge " +
  "(condition nodes: exactly one 'true' and one 'false'); when you insert a node between two others, REMOVE the edge " +
  "it replaces. " +
  "ENGINE CHECKS: the engine normalizes your candidate (declares variables, defaults positions, fixes x-source, moves " +
  "a script reference to the singular wiring) and validates it with the control plane BEFORE proposing. A tool result " +
  "with status 'not_proposed' lists 'guidance' — fix EXACTLY those points and call workflow_propose again with a NEW " +
  "idempotency_key. A result with status 'proposed' means the change set exists: stop and summarize it."

/** Attached to a confirmation-gated start result ({status:'requested',
 * run_id:null}) so the model cannot narrate a request as a running run. */
export const RUN_START_REQUESTED_REMINDER =
  "NOT started. A human must confirm this run in the Authorizations panel; report the authorization_id and say the run " +
  "has not begun. Do not call workflow_run_wait or workflow_run_get for it."

/** The run-side procedure, appended to the system prompt ONLY when the turn's
 * callback grants the 'run' feature. Idempotency/command/input ids derive
 * from the turn id so a retried turn replays instead of starting twice. */
export function runProcedure(turnId: string): string {
  return (
    `\n\nRUN PROCEDURE — follow it exactly:\n` +
    `1. Start a run ONLY when the user explicitly asks to run, execute, or start the workflow — never to test or check a ` +
    `proposal, and never more than one run per request unless the user asks for more.\n` +
    `2. workflow_run_start runs the SAVED workflow; source defaults to 'published' — say so in your answer. Use ` +
    `idempotency_key '${turnId}:run'. A result with status 'requested' (run_id null, authorization_id set) means the run ` +
    `has NOT started: it needs the user's one-click confirmation in the Authorizations panel. Report the authorization_id, ` +
    `say the run has not begun, and STOP — never call workflow_run_wait or workflow_run_get for a requested run, and never ` +
    `say it is running or queued. If the tool result is an error with code NO_PUBLISHED_VERSION, do not retry: tell the ` +
    `user there is no published version and OFFER source 'draft_snapshot' (runs the current draft) — start it only after ` +
    `they confirm.\n` +
    `3. Only when the start result is a run resource (it has a run_id and a run status such as 'queued' or 'running') may ` +
    `you call workflow_run_wait ONCE (bounded polling; every poll spends a gateway token). Then report run_id, status, and ` +
    `legal_controls VERBATIM from the latest resource, and say the run continues independently of this chat.\n` +
    `4. Controls: request only a command listed in the resource's legal_controls, with command_id '${turnId}:<command>'. ` +
    `Accepted ≠ effective. NEVER say a run is paused, resumed, or cancelled unless the control result's effective_status is ` +
    `'effective'; 'pending' means requested but not yet applied, 'unsupported' means the runtime cannot do it, 'failed' ` +
    `means it did not happen. Quote effective_status literally.\n` +
    `5. workflow_run_submit_input only answers a request the run itself declared in waiting_request (use that request_id; ` +
    `input_id '${turnId}:input'). It is never a way to steer, instruct, or modify the run.\n` +
    `6. When the user references \`@run <id>\`, read it FIRST with workflow_run_get (plus workflow_run_events / ` +
    `workflow_run_artifacts as needed) before answering, and never modify the running definition — a run executes the ` +
    `saved definition it started with.`
  )
}

/** The authorization procedure, appended to the system prompt ONLY when the
 * turn's callback grants the 'authorize' feature. The idempotency key derives
 * from the turn id so a retried turn replays instead of requesting twice. */
export function authorizationProcedure(turnId: string): string {
  return (
    `\n\nAUTHORIZATION PROCEDURE — follow it exactly:\n` +
    `1. A protected operation (publish, restore, set a version live, change or delete a schedule, cancel a batch) is never ` +
    `performed by you. You may only REQUEST an authorization for it, and only when the user explicitly asks for that operation.\n` +
    `2. Call workflow_request_authorization ONCE per operation with a fresh idempotency_key '${turnId}:auth' (':auth2' only ` +
    `for a second, distinct operation the user asked for), the subject_kind, the minimal subject_ref for that kind, and a ` +
    `one-sentence rationale quoting the user's request.\n` +
    `3. Report the authorization_id and status VERBATIM and say that a human must approve it in the Authorizations panel. ` +
    `status 'requested' means NOTHING has happened: never say the workflow was published, restored, or set live, the ` +
    `schedule changed or deleted, or the batch cancelled unless a readback shows status 'consumed'.\n` +
    `4. If the user asks whether it was approved, you may poll AT MOST ONCE with workflow_authorization_get (one gateway ` +
    `token); otherwise tell them where to look.\n` +
    `5. If the request fails with code AUTHORIZATION_SUBJECT_NOOP (nothing to do — e.g. the head is identical to the live ` +
    `version) or AUTHORIZATION_IDEMPOTENCY_CONFLICT (an equivalent request already exists), do NOT re-request: explain the ` +
    `code to the user (for a conflict, point them to the existing authorization). AUTHORIZATION_SUBJECT_UNSUPPORTED lists ` +
    `the allowed kinds in 'details.supported'; AUTHORIZATION_SUBJECT_REF_INVALID and AUTHORIZATION_SUBJECT_NOT_FOUND mean ` +
    `the reference is wrong — ask the user for the correct id instead of guessing; PERMISSION_DENIED means the user may not ` +
    `request this — say so.`
  )
}

export class LLMResponder implements TurnResponder {
  readonly name = "llm"
  private readonly trace: EngineTrace

  constructor(private readonly options: LLMResponderOptions) {
    assertAllowedUrl(`${options.modelOrigin}/v1/chat/completions`, options.policy)
    this.trace = options.trace ?? (() => {})
  }

  private async completion(messages: ChatMessage[], tools: unknown[] | undefined): Promise<{
    message: ChatMessage
    tokens: number
  }> {
    const url = `${this.options.modelOrigin}/v1/chat/completions`
    assertAllowedUrl(url, this.options.policy)
    const doFetch = this.options.fetchImpl ?? fetch
    const response = await doFetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        messages,
        ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
      }),
    })
    if (!response.ok) throw new Error(`model returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
    const data = (await response.json()) as {
      choices: { message: ChatMessage }[]
      usage?: { total_tokens?: number }
    }
    const message = data.choices?.[0]?.message
    if (!message) throw new Error("model returned no message")
    return { message, tokens: Number(data.usage?.total_tokens ?? 0) }
  }

  /** Make the candidate contract-shaped, lint it locally (free), then let the
   * control plane validate it (one token). Returns the graph to propose or
   * the issues/guidance to hand back to the model. */
  private async prepareCandidate(
    client: WorkflowControlPlaneClient,
    agentId: string,
    rawCandidate: unknown,
    state: TurnState,
  ): Promise<
    { ok: true; graph: JsonObject; repairs: readonly RepairNote[]; validation: unknown } | { ok: false; result: JsonObject }
  > {
    const { graph, repairs } = normalizeCandidate(rawCandidate, { head: state.head?.graph })
    const local = lintCandidate(graph)
    if (local.length) {
      return {
        ok: false,
        result: {
          status: "not_proposed",
          reason: "engine_precheck_failed",
          validation: { ok: false, issues: local },
          repairs,
          guidance: guidanceFor(local),
        },
      }
    }
    const evaluated = (await client.validateProposal(agentId, graph)) as JsonObject
    const validation = isObject(evaluated["validation"]) ? evaluated["validation"] : { ok: false, issues: ["validation unavailable"] }
    if (!validation["ok"]) {
      const issues = Array.isArray(validation["issues"]) ? (validation["issues"] as unknown[]) : []
      return {
        ok: false,
        result: {
          status: "not_proposed",
          reason: "validation_failed",
          validation,
          repairs,
          guidance: guidanceFor(issues),
          risk_level: evaluated["risk_level"],
        },
      }
    }
    return { ok: true, graph, repairs, validation: evaluated }
  }

  private async ensureHead(client: WorkflowControlPlaneClient, agentId: string, state: TurnState): Promise<HeadSnapshot> {
    if (state.head) return state.head
    const head = asHead(await client.workflowHead(agentId))
    if (!head) throw new Error("workflow head unavailable")
    state.head = head
    return head
  }

  /** The tool dispatch with the proposal interception. Read tools pass
   * straight through (head is snapshotted); validate/propose are guarded;
   * run start/control/wait are traced. Only the tools the turn's features
   * unlock resolve at all. */
  private async runTool(
    turnId: string,
    name: string,
    args: Record<string, unknown>,
    client: WorkflowControlPlaneClient,
    state: TurnState,
    features: readonly string[],
  ): Promise<unknown> {
    const tool = resolveFeatureTool(features, name)
    const agentId = String(args["agent_id"])
    const context = { sleep: this.options.sleep }
    if (name === "workflow_run_start") {
      // Link the run to this authoring turn for the audit trail; the model's
      // schema has no turn_id field, so this is engine-set, never model-set.
      args["turn_id"] = turnId
      const output = await tool.execute(client, args, context)
      const resource = isObject(output) ? output : {}
      const argSource = typeof args["source"] === "string" && args["source"] ? args["source"] : "published"
      if (resource["status"] === "requested" && (resource["run_id"] === null || resource["run_id"] === undefined)) {
        // Confirmation-gated start (12.8 step 7): the gateway materialized a
        // bound 'run.start' authorization instead of a run. Nothing runs until
        // a human confirms it, so this is neither a start nor pollable — the
        // reminder travels with the result so the model cannot miss it.
        const binding = isObject(resource["binding"]) ? resource["binding"] : {}
        state.runsRequested += 1
        this.trace("run_start_requested", {
          turn_id: turnId,
          authorization_id: resource["authorization_id"],
          source: binding["source"] ?? argSource,
        })
        return { ...resource, reminder: RUN_START_REQUESTED_REMINDER }
      }
      const definition = isObject(resource["definition"]) ? resource["definition"] : {}
      state.runsStarted += 1
      this.trace("run_started", {
        turn_id: turnId,
        run_id: resource["run_id"],
        status: resource["status"],
        source: definition["source"] ?? argSource,
      })
      return output
    }
    if (name === "workflow_run_control") {
      const output = await tool.execute(client, args, context)
      if (this.noteRunIdRefusal(turnId, name, output)) return output
      const result = isObject(output) ? output : {}
      this.trace("run_control", {
        turn_id: turnId,
        run_id: args["run_id"],
        command: args["command"],
        effective_status: result["effective_status"],
      })
      return output
    }
    if (name === "workflow_run_wait") {
      const output = await tool.execute(client, args, context)
      if (this.noteRunIdRefusal(turnId, name, output)) return output
      const waited = output as RunWaitResult
      this.trace("run_wait", { turn_id: turnId, run_id: args["run_id"], polls: waited.polls, reason: waited.reason })
      return output
    }
    if (name === "workflow_request_authorization") {
      // Engine-set linkage, and workflow.* subjects are pinned to the turn's
      // agent exactly like every agent-scoped tool — the model never chooses
      // which workflow a publish/restore/set_live request is about.
      args["turn_id"] = turnId
      const subjectKind = typeof args["subject_kind"] === "string" ? args["subject_kind"] : ""
      if (subjectKind.startsWith("workflow.")) {
        const ref = isObject(args["subject_ref"]) ? { ...args["subject_ref"] } : {}
        ref["agent_id"] = agentId
        args["subject_ref"] = ref
      }
      const output = await tool.execute(client, args, context)
      const view = isObject(output) ? output : {}
      state.authorizationsRequested += 1
      this.trace("authorization_requested", {
        turn_id: turnId,
        authorization_id: view["authorization_id"],
        subject_kind: view["subject_kind"] ?? subjectKind,
        status: view["status"],
        replayed: view["replayed"] === true,
      })
      return output
    }
    if (name === "workflow_head") {
      const output = await tool.execute(client, args)
      state.head = asHead(output) ?? state.head
      return output
    }
    if (name === "workflow_validate_proposal") {
      state.attempts += 1
      const prepared = await this.prepareCandidate(client, agentId, args["candidate_graph"], state)
      if (!prepared.ok) return prepared.result
      return { ...(prepared.validation as JsonObject), repairs: prepared.repairs, normalized_candidate_graph: prepared.graph }
    }
    if (name === "workflow_propose") {
      state.attempts += 1
      let rawCandidate: unknown = args["candidate_graph"]
      if (Array.isArray(args["patch_ops"]) && !isObject(rawCandidate)) {
        const head = await this.ensureHead(client, agentId, state)
        try {
          rawCandidate = applyPatchOps(head.graph, args["patch_ops"])
        } catch (error) {
          const message = error instanceof PatchError ? error.message : "patch could not be applied"
          return {
            status: "not_proposed",
            reason: "patch_rejected",
            validation: { ok: false, issues: [{ code: "PATCH_REJECTED", message }] },
            guidance: [
              `PATCH_REJECTED: ${message} → patch_ops apply to the CURRENT head: set_node/remove_node/remove_edge need existing ids, add_node/add_edge need NEW ids.`,
            ],
          }
        }
      }
      if (!isObject(rawCandidate)) {
        return {
          status: "not_proposed",
          reason: "empty_payload",
          guidance: ["Provide either candidate_graph (full graph) or patch_ops (bounded ops against the head)."],
        }
      }
      const prepared = await this.prepareCandidate(client, agentId, rawCandidate, state)
      if (!prepared.ok) {
        const validation = prepared.result["validation"] as JsonObject | undefined
        this.trace("proposal_not_created", {
          turn_id: turnId,
          agent: agentId,
          reason: prepared.result["reason"],
          issues: Array.isArray(validation?.["issues"]) ? (validation!["issues"] as unknown[]).length : 0,
          repairs: Array.isArray(prepared.result["repairs"]) ? (prepared.result["repairs"] as unknown[]).length : 0,
          attempt: state.attempts,
        })
        return prepared.result
      }
      const output = (await client.propose(agentId, {
        base_generation: Number(args["base_generation"]),
        base_hash: String(args["base_hash"]),
        candidate_graph: prepared.graph,
        idempotency_key: String(args["idempotency_key"]),
      })) as JsonObject
      if (output["status"] === "proposed") state.proposed = true
      this.trace("proposal_created", {
        turn_id: turnId,
        agent: agentId,
        change_set_id: output["change_set_id"],
        status: output["status"],
        risk_level: output["risk_level"],
        repairs: prepared.repairs.length,
        attempt: state.attempts,
      })
      return { ...output, repairs: prepared.repairs }
    }
    const output = await tool.execute(client, args, context)
    this.noteRunIdRefusal(turnId, name, output)
    return output
  }

  /** A run-family tool refused itself locally for want of a run_id (e.g. the
   * model tried to read or wait on a confirmation-gated start). No gateway
   * token was spent; the result explains itself — this only leaves a trace. */
  private noteRunIdRefusal(turnId: string, name: string, output: unknown): boolean {
    if (!isObject(output) || output["code"] !== RUN_ID_REQUIRED_CODE) return false
    this.trace("run_tool_refused", { turn_id: turnId, tool: name, reason: "missing_run_id" })
    return true
  }

  async respond(request: TurnRequest): Promise<{ reply: string; totalTokens: number }> {
    const callback = request.callback
    const tokens = [...(callback?.tokens ?? [])]
    const client =
      callback && tokens.length
        ? new WorkflowControlPlaneClient({
            baseUrl: callback.gatewayUrl,
            policy: this.options.policy,
            fetchImpl: this.options.fetchImpl,
            tokenProvider: () => {
              const token = tokens.shift()
              if (!token) throw new ToolDeniedError("gateway token budget exhausted")
              return token
            },
          })
        : null

    // Feature grants decide which tools the model even sees: reads always,
    // proposal tools with 'propose', run tools with 'run'. A callback without
    // a features list keeps the legacy ['propose'] grant.
    const features = callbackFeatures(callback)
    const proposeEnabled = features.includes("propose")
    const runEnabled = features.includes("run")
    const authorizeEnabled = features.includes("authorize")

    const toolDefs = client
      ? toolsForFeatures(features).map((tool) => ({
          type: "function",
          function: { name: tool.id, description: tool.description, parameters: tool.parameters },
        }))
      : undefined

    const profilePrompt = proposeEnabled
      ? PROPOSAL_WORKFLOW_PROFILE.prompt + "\n\n" + SCHEMA_HINT
      : runEnabled
        ? RUN_WORKFLOW_PROFILE.prompt
        : authorizeEnabled
          ? AUTHORIZE_WORKFLOW_PROFILE.prompt
          : MANAGED_WORKFLOW_PROFILE.prompt
    const system =
      profilePrompt +
      (callback ? `\n\nThe workflow agent id is ${callback.agentId}.` : "") +
      (callback && proposeEnabled
        ? ` WORKFLOW-CHANGE PROCEDURE — follow it exactly:\n` +
          `1. Call workflow_head to read the current graph, generation, and content_hash.\n` +
          `2. For a SMALL edit (rename, retarget an edge, change one node's fields, add/remove a single node or edge), ` +
          `propose with patch_ops — surgical operations against the head: ` +
          `{op:'set_node',node:{...full node object with the same id...}}, {op:'add_node',node:{...}}, ` +
          `{op:'remove_node',id}, {op:'add_edge',edge:{id,from,to,when}}, {op:'remove_edge',id}, ` +
          `{op:'set_settings',settings:{...}}. To RETARGET an edge: remove_edge its id, then add_edge the corrected ` +
          `edge (you may reuse the id). To INSERT a node between A and B: remove_edge A→B, add_node, add_edge A→new, ` +
          `add_edge new→B (plus the new node's error edge). patch_ops never rewrite the rest of the graph, so prefer them.\n` +
          `3. When replacing or creating most of the workflow, propose with a full candidate_graph (the engine ` +
          `validates it for you first).\n` +
          `4. Call workflow_propose with the EXACT base_generation/base_hash from step 1 and idempotency_key ` +
          `'${request.turnId}'. If the result has status 'not_proposed', apply its 'guidance' and propose again with ` +
          `idempotency_key '${request.turnId}:retry1' (then ':retry2', ':retry3').\n` +
          `5. Once a result has status 'proposed', summarize what you proposed and its risk level.`
        : "") +
      (callback && runEnabled ? runProcedure(request.turnId) : "") +
      (callback && authorizeEnabled ? authorizationProcedure(request.turnId) : "")
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...request.history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: "user", content: request.content },
    ]

    const state: TurnState = {
      attempts: 0,
      proposed: false,
      nudged: false,
      runsStarted: 0,
      runsRequested: 0,
      authorizationsRequested: 0,
    }
    let totalTokens = 0
    let toolCalls = 0
    for (let round = 0; round < MAX_MODEL_ROUNDS; round++) {
      const { message, tokens: used } = await this.completion(messages, toolDefs)
      totalTokens += used
      if (!message.tool_calls || message.tool_calls.length === 0 || !client) {
        // One-shot completion nudge: the model tried to change the workflow
        // (validate/propose attempts) but no change set exists and it is
        // about to stop. Ask once; a reasoned "no change needed" is fine.
        if (client && state.attempts > 0 && !state.proposed && !state.nudged && tokens.length > 0) {
          state.nudged = true
          this.trace("completion_nudge", { turn_id: request.turnId, attempts: state.attempts, round })
          messages.push(message)
          messages.push({
            role: "user",
            content:
              "No change set was created yet (your propose attempts did not succeed). Fix the last 'guidance' and call " +
              "workflow_propose again with a new idempotency_key — or, if the request genuinely needs no change, say so explicitly.",
          })
          continue
        }
        this.trace("responder_done", {
          turn_id: request.turnId,
          model: this.options.model,
          rounds: round + 1,
          tool_calls: toolCalls,
          total_tokens: totalTokens,
          proposed: state.proposed,
          runs_started: state.runsStarted,
          runs_requested: state.runsRequested,
          authorizations_requested: state.authorizationsRequested,
          features: [...features],
          tokens_left: tokens.length,
        })
        return { reply: message.content ?? "", totalTokens }
      }
      messages.push(message)
      for (const call of message.tool_calls) {
        let result: string
        if (toolCalls >= MAX_TOOL_CALLS) {
          this.trace("tool_budget_exhausted", { turn_id: request.turnId, tool: call.function.name, max: MAX_TOOL_CALLS })
          result = JSON.stringify({ error: "tool budget exhausted" })
        } else {
          toolCalls += 1
          try {
            const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>
            // The turn is bound to ONE workflow: the model never chooses the
            // agent (a mistyped id was a whole-turn 404 in the live trials).
            // Run ids pass through untouched — a run is not scoped by the
            // agent path, the gateway checks its ownership server-side.
            args["agent_id"] = callback!.agentId
            const output = await this.runTool(request.turnId, call.function.name, args, client, state, features)
            result = JSON.stringify(output).slice(0, TOOL_RESULT_CAP)
          } catch (error) {
            // Denied or failing tools surface as data, never as execution.
            // A gateway `{code, message}` detail is passed through so the
            // model can act on the code (e.g. NO_PUBLISHED_VERSION).
            const name = error instanceof Error ? error.name : "Error"
            const gateway = error instanceof ControlPlaneError ? error : undefined
            this.trace(name === "ToolDeniedError" ? "tool_denied" : "tool_failed", {
              turn_id: request.turnId,
              tool: call.function.name,
              error: name,
              ...(gateway ? { status: gateway.status, code: gateway.code ?? null } : {}),
            })
            if (name === "ToolDeniedError" && isAuthorizationToolId(call.function.name) && !features.includes("authorize")) {
              // The model reached for an authorization tool on a turn the
              // control plane did not grant 'authorize' to — worth its own line.
              this.trace("authorization_denied_tool", {
                turn_id: request.turnId,
                tool: call.function.name,
                features: [...features],
              })
            }
            result = JSON.stringify({
              error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "tool failed",
              ...(gateway ? { status: gateway.status } : {}),
              ...(gateway?.code ? { code: gateway.code } : {}),
              ...(gateway?.detail ? { message: gateway.detail } : {}),
              ...(gateway?.extra ? { details: gateway.extra } : {}),
            })
          }
        }
        messages.push({ role: "tool", content: result, tool_call_id: call.id })
      }
    }
    this.trace("responder_done", {
      turn_id: request.turnId,
      model: this.options.model,
      rounds: MAX_MODEL_ROUNDS,
      tool_calls: toolCalls,
      total_tokens: totalTokens,
      proposed: state.proposed,
      runs_started: state.runsStarted,
      runs_requested: state.runsRequested,
      authorizations_requested: state.authorizationsRequested,
      features: [...features],
      reason: "round_budget_exhausted",
    })
    return { reply: "(turn ended: model round budget exhausted)", totalTokens }
  }
}
