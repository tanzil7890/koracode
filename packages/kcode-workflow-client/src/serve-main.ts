// kcode-workflow-serve — the managed authoring engine binary entrypoint.
//
// Compiled standalone (bun build --compile) for the hardened container in
// workflows/docker/koracode-authoring.Dockerfile. Reads only PORT/HOSTNAME/
// KORA_WORKSPACE_ROOT; makes no outbound calls (see serve.ts contract).

import { mkdirSync } from "node:fs"

import { LLMResponder } from "./llm-responder"
import { policyFromEnv } from "./egress"
import { WorkflowServe } from "./serve"

// A tmpfs mounted over /var/lib/koracode shadows the image's directories —
// recreate the workspace root at boot (0700, our uid) before serving.
const workspaceRoot = process.env["KORA_WORKSPACE_ROOT"] ?? "/var/lib/koracode/workspaces"
mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 })

// Model responder when a key is configured; the deterministic drill
// responder otherwise (12.4 drill posture). Egress stays pinned either way.
const modelKey = process.env["KORA_MODEL_API_KEY"] ?? ""
const responder = modelKey
  ? new LLMResponder({
      apiKey: modelKey,
      model: process.env["KORA_MODEL"] ?? "gpt-4.1-mini",
      modelOrigin: process.env["KORA_MODEL_ORIGIN"] ?? "https://api.openai.com",
      policy: policyFromEnv(),
    })
  : undefined

const serve = new WorkflowServe({ workspaceRoot, responder })
console.error(`responder: ${modelKey ? "llm" : "drill"}`)

const port = Number(process.env["PORT"] ?? 4096)
const hostname = process.env["HOSTNAME_BIND"] ?? "0.0.0.0"

Bun.serve({
  port,
  hostname,
  fetch: (request) => serve.fetch(request),
})

console.error(`kcode-workflow-serve listening on ${hostname}:${port} (managed-workflow profile only)`)
