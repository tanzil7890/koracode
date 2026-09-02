/**
 * The kernel reaches nothing outside itself, and the audit that says so works.
 *
 * The second half matters as much as the first: an audit nobody has seen fail
 * is a rule, not a guarantee. Each planted violation below is one of the things
 * Phase 12.10 forbids by name.
 */
import { describe, expect, test } from "bun:test"
import { audit, auditSource } from "../script/purity"

describe("hermetic sources", () => {
  test("no source reaches a browser, model, database, file, process, socket, or clock", async () => {
    const findings = await audit()
    expect(findings.map((finding) => `${finding.file}:${finding.line} ${finding.detail}`)).toEqual([])
  })
})

describe("the audit itself", () => {
  const planted: readonly (readonly [string, string])[] = [
    ["the OpenCode session runner", 'import { SessionRunner } from "@opencode-ai/core"'],
    ["a browser", 'import { chromium } from "playwright"'],
    ["a model provider", 'import { openai } from "@ai-sdk/openai"'],
    ["a database", 'import { Database } from "bun:sqlite"'],
    ["the filesystem", 'import { readFile } from "node:fs/promises"'],
    ["a process", 'import { spawn } from "node:child_process"'],
    ["a socket", "const response = fetch(url)"],
    ["an ambient clock", "const now = Date.now()"],
    ["ambient randomness", "const pick = Math.random()"],
    ["ambient configuration", "const flag = process.env.KORA_FLAG"],
    ["asynchrony", "async function walk() {}"],
  ]

  planted.forEach(([what, source]) => {
    test(`catches ${what}`, () => {
      expect(auditSource("src/planted.ts", source).length).toBeGreaterThan(0)
    })
  })

  test("does not fire on prose that merely names a forbidden thing", () => {
    expect(auditSource("src/planted.ts", "// a browser would use fetch( here, and we do not")).toEqual([])
  })
})
