// Smoke test for the documented workspace-import pattern: agent writes
// .ts files to <projectDir>/.bcode/agent-workspace/, then imports them
// at runtime from a `browser_execute` snippet via
// `await import("/abs/path?t=" + Date.now())`. We don't run a real
// `browser_execute` here — the point is to verify the dynamic-import
// mechanism behaves as the browser-execute skill prompt claims.
//
// All four scenarios run against a real tmp dir, real .ts files, and
// the real Bun module loader. No mocks.

import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"

let workspace: string

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "bcode-ws-"))
})

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true })
})

test("await import(absPath) returns the workspace .ts module", async () => {
  const file = path.join(workspace, "scrape.ts")
  await fs.writeFile(file, `export const run = async () => "v1"\n`, "utf8")
  const m = await import(file)
  expect(await m.run()).toBe("v1")
})

test("edit + cache-bust returns the fresh module", async () => {
  const file = path.join(workspace, "fresh.ts")
  await fs.writeFile(file, `export const run = async () => "before"\n`, "utf8")
  const a = await import(`${file}?t=${Date.now()}`)
  expect(await a.run()).toBe("before")
  await fs.writeFile(file, `export const run = async () => "after"\n`, "utf8")
  const b = await import(`${file}?t=${Date.now() + 1}`)
  expect(await b.run()).toBe("after")
})

test("syntax error in workspace file surfaces a clean rejection", async () => {
  const file = path.join(workspace, "broken.ts")
  await fs.writeFile(file, `export const run = (\n`, "utf8")
  expect(async () => {
    await import(`${file}?t=${Date.now()}`)
  }).toThrow()
})

test("nested workspace paths import the same way", async () => {
  const subdir = path.join(workspace, "scrapers", "social")
  await fs.mkdir(subdir, { recursive: true })
  const file = path.join(subdir, "tweet.ts")
  await fs.writeFile(file, `export const run = async () => "nested"\n`, "utf8")
  const m = await import(file)
  expect(await m.run()).toBe("nested")
})
