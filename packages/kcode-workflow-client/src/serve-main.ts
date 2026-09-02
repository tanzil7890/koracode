// kcode-workflow-serve — the managed authoring engine binary entrypoint.
//
// Compiled standalone (bun build --compile) for the hardened container in
// workflows/docker/koracode-authoring.Dockerfile. Reads only PORT/HOSTNAME/
// KORA_WORKSPACE_ROOT (+ the model env); makes no outbound calls beyond the
// pinned egress policy (see serve.ts / egress.ts).

import { mkdirSync } from "node:fs"

import { LLMResponder } from "./llm-responder"
import { policyFromEnv } from "./egress"
import { type EngineTrace, WorkflowServe } from "./serve"

// One JSON line per engine event on stderr — the container log's answer to
// "which responder handled this turn, and did it propose?". Mirrors the
// control plane's `authoring.engine` lines; never carries turn content.
const trace: EngineTrace = (event, fields) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), component: "kcode-workflow-serve", event, ...fields }))
}

// A tmpfs mounted over /var/lib/koracode shadows the image's directories —
// recreate the workspace root at boot (0700, our uid) before serving.
const workspaceRoot = process.env["KORA_WORKSPACE_ROOT"] ?? "/var/lib/koracode/workspaces"
mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })

// Model responder when a key is configured; the deterministic drill
// responder otherwise (12.4 drill posture). Egress stays pinned either way.
const modelKey = process.env["KORA_MODEL_API_KEY"] ?? ""
const model = process.env["KORA_MODEL"] ?? "gpt-4.1-mini"
const modelOrigin = process.env["KORA_MODEL_ORIGIN"] ?? "https://api.openai.com"
const responder = modelKey
  ? new LLMResponder({
      apiKey: modelKey,
      model,
      modelOrigin,
      policy: policyFromEnv(),
      trace,
    })
  : undefined

const serve = new WorkflowServe({ workspaceRoot, responder, trace })

const port = Number(process.env["PORT"] ?? 4096)
const hostname = process.env["HOSTNAME_BIND"] ?? "0.0.0.0"

Bun.serve({
  port,
  hostname,
  fetch: (request) => serve.fetch(request),
})

trace("engine_config", {
  responder: modelKey ? "llm" : "drill",
  model: modelKey ? model : null,
  model_origin: modelKey ? modelOrigin : null,
  listen: `${hostname}:${port}`,
  profile: "managed-workflow",
})
