# CDP layer provenance

Initial copy from `browser-use/browser-harness-js@95b7a22a923714c45d2f7234b2bfa8fa6322c2eb` (`sdk/`), 2026-05-07.

| File | Source |
|---|---|
| `session.ts` | `sdk/session.ts` |
| `gen.ts` | `sdk/gen.ts` |
| `generated.ts` | `sdk/generated.ts` (output of `bun gen.ts` against the protocol JSONs) |
| `browser_protocol.json` | `sdk/browser_protocol.json` (mirror of `chromedevtools/devtools-protocol`) |
| `js_protocol.json` | `sdk/js_protocol.json` (mirror of `chromedevtools/devtools-protocol`) |

**Initial copy only.** Subsequent edits diverge from upstream by design — see Phase H hard rule #2 in `memory/browsercode/phase_h_migration_plan.md`. The `browser-harness-js` repo was a proof of concept that informed this architecture; it is not a future source of truth. Behaviors from `browser-use/browser-harness` (the Python harness) are tracked separately in `memory/browsercode/harness_watchlist.md` and ported individually as needed.

To regenerate `generated.ts` after a protocol JSON refresh:

```
bun run cdp:gen
```

(from `packages/bcode-browser/`).
