// Model-backed TurnResponder — Phase 12.7 steps 6–7 (the live-trial engine).
//
// An OpenAI-compatible tool-calling loop over EXACTLY the proposal tool
// surface (read + validate/propose/status — resolveProposalTool is the only
// lookup, so an injected request for bash/edit/apply cannot execute). Every
// network call goes through the pinned egress policy: the model origin and
// the Kora gateway, nothing else. Gateway calls consume one-use callback
// tokens the control plane minted for this turn; when they run out, the
// loop stops — a hard, control-plane-owned tool budget.
//
// Engine quality (v7): the responder never sends an off-contract candidate.
// A propose is intercepted and run through normalize → local lint → gateway
// validate; only a candidate the control plane accepts is proposed, so a
// rejected change set can no longer be a turn's outcome. Anything the engine
// must not guess comes back to the model as precise, code-keyed guidance.

import {
  PatchError,
  applyPatchOps,
  guidanceFor,
  lintCandidate,
  normalizeCandidate,
  type JsonObject,
  type RepairNote,
} from "./candidate-repair"
import { WorkflowControlPlaneClient } from "./client"
import { assertAllowedUrl, type EgressPolicy } from "./egress"
import { PROPOSAL_WORKFLOW_PROFILE } from "./profile"
import type { TurnRequest, TurnResponder } from "./serve"
import { ToolDeniedError, WORKFLOW_PROPOSAL_TOOLS, WORKFLOW_READ_TOOLS, resolveProposalTool } from "./tools"

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

export class LLMResponder implements TurnResponder {
  constructor(private readonly options: LLMResponderOptions) {
    assertAllowedUrl(`${options.modelOrigin}/v1/chat/completions`, options.policy)
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
   * straight through (head is snapshotted); validate/propose are guarded. */
  private async runTool(
    name: string,
    args: Record<string, unknown>,
    client: WorkflowControlPlaneClient,
    state: TurnState,
  ): Promise<unknown> {
    const tool = resolveProposalTool(name)
    const agentId = String(args["agent_id"])
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
      if (!prepared.ok) return prepared.result
      const output = (await client.propose(agentId, {
        base_generation: Number(args["base_generation"]),
        base_hash: String(args["base_hash"]),
        candidate_graph: prepared.graph,
        idempotency_key: String(args["idempotency_key"]),
      })) as JsonObject
      if (output["status"] === "proposed") state.proposed = true
      return { ...output, repairs: prepared.repairs }
    }
    return tool.execute(client, args)
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

    const toolDefs = client
      ? [...WORKFLOW_READ_TOOLS, ...WORKFLOW_PROPOSAL_TOOLS].map((tool) => ({
          type: "function",
          function: { name: tool.id, description: tool.description, parameters: tool.parameters },
        }))
      : undefined

    const system =
      PROPOSAL_WORKFLOW_PROFILE.prompt +
      "\n\n" +
      SCHEMA_HINT +
      (callback
        ? `\n\nThe workflow agent id is ${callback.agentId}. WORKFLOW-CHANGE PROCEDURE — follow it exactly:\n` +
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
        : "")
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...request.history.map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: "user", content: request.content },
    ]

    const state: TurnState = { attempts: 0, proposed: false, nudged: false }
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
          messages.push(message)
          messages.push({
            role: "user",
            content:
              "No change set was created yet (your propose attempts did not succeed). Fix the last 'guidance' and call " +
              "workflow_propose again with a new idempotency_key — or, if the request genuinely needs no change, say so explicitly.",
          })
          continue
        }
        return { reply: message.content ?? "", totalTokens }
      }
      messages.push(message)
      for (const call of message.tool_calls) {
        let result: string
        if (toolCalls >= MAX_TOOL_CALLS) {
          result = JSON.stringify({ error: "tool budget exhausted" })
        } else {
          toolCalls += 1
          try {
            const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>
            // The turn is bound to ONE workflow: the model never chooses the
            // agent (a mistyped id was a whole-turn 404 in the live trials).
            args["agent_id"] = callback!.agentId
            const output = await this.runTool(call.function.name, args, client, state)
            result = JSON.stringify(output).slice(0, TOOL_RESULT_CAP)
          } catch (error) {
            // Denied or failing tools surface as data, never as execution.
            result = JSON.stringify({
              error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 300)}` : "tool failed",
            })
          }
        }
        messages.push({ role: "tool", content: result, tool_call_id: call.id })
      }
    }
    return { reply: "(turn ended: model round budget exhausted)", totalTokens }
  }
}
