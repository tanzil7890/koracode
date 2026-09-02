// @koracode/kcode-workflow-client — Roadmap 12 Phase 12.4.
//
// Everything the managed KoraCode authoring profile may do lives here:
//   egress.ts  — the single pinned-URL gate (control plane + model origins)
//   client.ts  — the read-only Kora gateway client
//   tools.ts   — the exact workflow_* tool surface (deny-by-default lookup)
//   profile.ts — the managed agent profile + telemetry-off env contract
//   binding.ts — product-thread ↔ disposable-session adapter with recovery

export * from "./egress"
export * from "./client"
export * from "./tools"
export * from "./profile"
export * from "./binding"
