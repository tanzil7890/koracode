/**
 * The purity audit.
 *
 * The kernel's whole claim is that it decides and never acts. This script is
 * what makes that claim checkable rather than aspirational: it reads every
 * source file and refuses any import or global that could reach a browser, a
 * model, a database, a file, a process, a socket, or an ambient clock.
 *
 * It is a build-time audit, not a semantic test, which is why it lives here and
 * not under `test/`.
 */
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "..")

/** The only things `src/` may import. Everything else is a finding. */
const allowedPackages = new Set(["@koracode/kcode-workflow-contracts", "ajv/dist/2020.js", "ajv/dist/core.js"])

/**
 * Substrings that betray an effect. Each is paired with what it would let the
 * kernel do, so a finding reads as a reason and not just a rule number.
 */
const forbiddenTokens: readonly { readonly token: string; readonly why: string }[] = [
  { token: "node:fs", why: "filesystem access" },
  { token: "node:child_process", why: "process spawning" },
  { token: "node:process", why: "process and environment access" },
  { token: "node:net", why: "raw sockets" },
  { token: "node:dns", why: "name resolution" },
  { token: "node:tls", why: "network transport" },
  { token: "node:http", why: "network transport" },
  { token: "node:worker_threads", why: "concurrency outside the caller's control" },
  { token: "node:v8", why: "runtime introspection" },
  { token: "node:vm", why: "dynamic evaluation" },
  { token: "bun:sqlite", why: "a database" },
  { token: "bun:ffi", why: "native code" },
  { token: "playwright", why: "a browser" },
  { token: "puppeteer", why: "a browser" },
  { token: "@opencode-ai/", why: "the OpenCode session runner" },
  { token: "@koracode/koracode-core", why: "the OpenCode session runner" },
  { token: "@koracode/kcode-browser", why: "a browser" },
  { token: "@koracode/kcode-serve", why: "a server" },
  { token: "@koracode/kcode-workflow-client", why: "a control-plane client" },
  { token: "@ai-sdk/", why: "a model provider" },
  { token: "SessionRunner", why: "the OpenCode session runner" },
  { token: "process.env", why: "ambient configuration" },
  { token: "process.argv", why: "ambient configuration" },
  { token: "process.exit", why: "process control" },
  { token: "Bun.file", why: "filesystem access" },
  { token: "Bun.write", why: "filesystem access" },
  { token: "Bun.spawn", why: "process spawning" },
  { token: "Bun.serve", why: "a server" },
  { token: "Bun.connect", why: "network transport" },
  { token: "Bun.$", why: "a shell" },
  { token: "Bun.env", why: "ambient configuration" },
  { token: "Bun.Glob", why: "filesystem access" },
  { token: "fetch(", why: "network transport" },
  { token: "XMLHttpRequest", why: "network transport" },
  { token: "WebSocket", why: "network transport" },
  { token: "EventSource", why: "network transport" },
  { token: "localStorage", why: "host storage" },
  { token: "Math.random", why: "ambient randomness" },
  { token: "Date.now", why: "an ambient clock" },
  { token: "new Date", why: "an ambient clock" },
  { token: "performance.now", why: "an ambient clock" },
  { token: "setTimeout", why: "an ambient clock" },
  { token: "setInterval", why: "an ambient clock" },
  { token: "queueMicrotask", why: "scheduling the kernel does not own" },
  { token: "globalThis", why: "ambient state" },
  { token: "require(", why: "dynamic loading" },
  { token: "eval(", why: "dynamic evaluation" },
]

/** Async work is the shape an effect arrives in; the kernel has none. */
const forbiddenShapes: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /\basync\b/, why: "asynchrony, which a pure kernel never needs" },
  { pattern: /\bawait\b/, why: "asynchrony, which a pure kernel never needs" },
  { pattern: /\bnew Promise\b/, why: "asynchrony, which a pure kernel never needs" },
]

const importPattern = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s+["']([^"']+)["']/g

export type Finding = { readonly file: string; readonly line: number; readonly detail: string }

export async function audit(): Promise<readonly Finding[]> {
  const findings: Finding[] = []
  const files = (await Array.fromAsync(new Bun.Glob("src/**/*.ts").scan({ cwd: root, onlyFiles: true }))).toSorted(
    (left, right) => (left < right ? -1 : left > right ? 1 : 0),
  )
  if (files.length === 0) throw new Error("the purity audit found no sources to read")

  for (const relative of files) {
    findings.push(...auditSource(relative, await Bun.file(resolve(root, relative)).text()))
  }
  return findings
}

/** The whole rule set, over one file's text. Exported so a test can plant a violation. */
export function auditSource(file: string, source: string): readonly Finding[] {
  const findings: Finding[] = []
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? ""
    if (specifier.startsWith(".")) continue
    if (allowedPackages.has(specifier)) continue
    findings.push({
      file,
      line: lineOf(source, match.index ?? 0),
      detail: `imports ${specifier}, which is not on the kernel's allowlist`,
    })
  }
  source.split("\n").forEach((line, index) => {
    const code = withoutComment(line)
    forbiddenTokens.forEach(({ token, why }) => {
      if (code.includes(token)) findings.push({ file, line: index + 1, detail: `${token} would give it ${why}` })
    })
    forbiddenShapes.forEach(({ pattern, why }) => {
      if (pattern.test(code)) findings.push({ file, line: index + 1, detail: `introduces ${why}` })
    })
  })
  return findings
}

/** Findings are about code, so prose that mentions a forbidden name is fine. */
function withoutComment(line: string): string {
  const trimmed = line.trimStart()
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return ""
  const marker = line.indexOf("//")
  return marker === -1 ? line : line.slice(0, marker)
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length
}

if (import.meta.main) {
  const findings = await audit()
  if (findings.length === 0) {
    console.log("purity audit: the kernel reaches nothing outside itself")
  } else {
    findings.forEach((finding) => console.error(`${finding.file}:${finding.line} ${finding.detail}`))
    console.error(`purity audit failed with ${findings.length} finding(s)`)
  }
  process.exit(findings.length === 0 ? 0 : 1)
}
