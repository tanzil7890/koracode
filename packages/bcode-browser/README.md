# @browser-use/bcode-browser

Level-1 BrowserCode package: substantial, self-contained code with zero upstream-fork friction.

See `decisions.md §1c` (three-level model) and `§1d` (this package) in the BrowserCode project memory.

## Contents

| Path | Purpose |
|---|---|
| `src/cdp/` | Vendored CDP layer (`session.ts`, `gen.ts`, `generated.ts`, protocol JSONs). Initial copy from `browser-use/browser-harness-js`; ours after — see `src/cdp/PROVENANCE.md`. |
| `src/browser-execute.ts` | In-process JS-eval `browser_execute` body. |
| `src/session-store.ts` | Per-opencode-session CDP `Session` map. The agent calls `session.connect(...)` from a snippet; subsequent snippets find the same Session. |
| `src/skills.ts` | Runtime resolver for embedded skills (extract on first call in compiled mode; in-tree path in dev). |
| `skills/` | `browser-execute/SKILL.md` (the agent-facing reference for `browser_execute`, covering all three connection Ways including Browser Use cloud provisioning via raw HTTP from inside a snippet). Registered as an opencode skill via frontmatter; surfaced in `<available_skills>` and loaded with the `skill` tool. Embedded into the binary by `script/embed-skills.ts`. The interaction-skills set inherited from the Python harness was archived 2026-05-09 — we'll reintroduce only what evals show is needed, one skill at a time. |
| `script/embed-skills.ts` | Build-time embed; emits `bcode-skills.gen.ts` consumed by the compiled binary. |
| `test/` | `bun test` smoke coverage for the workspace dynamic-import pattern. |

Planned (per ROADMAP phase): `src/fetch-use/` (B1), `src/cloud/` deploy/skillbase/judge clients (D3–D4).

Integration into `packages/opencode` (tool registration, service wiring, CLI commands) is Level 2 and lives in `packages/opencode/src`. Per the one-line-hook rule, those hooks are pointers only — all logic lives here.
