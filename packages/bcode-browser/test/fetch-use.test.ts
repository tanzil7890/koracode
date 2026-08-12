// FetchUse smoke tests.
//
// Unit: layer is constructible, `enabled` reflects BROWSER_USE_API_KEY presence.
// Live: when the key is set, end-to-end POST to fetch.browser-use.com returns
//       body bytes + content-type. Skipped without the key. Config-based
//       opt-in (experimental.fetch_use=true) is enforced in webfetch.ts,
//       not here.

import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { FetchUse } from "../src/fetch-use"

const haveKey = !!process.env.BROWSER_USE_API_KEY

test("layer constructs and exposes `enabled` reflecting env", async () => {
  const enabled = await Effect.gen(function* () {
    return (yield* FetchUse.Service).enabled
  }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.runPromise)
  expect(enabled).toBe(haveKey)
})

test.skipIf(!haveKey)("live: fetches httpbin and returns body + content-type", async () => {
  const result = await Effect.gen(function* () {
    return yield* (yield* FetchUse.Service).fetch("https://httpbin.org/get", { timeoutMs: 30_000 })
  }).pipe(Effect.provide(FetchUse.layer.pipe(Layer.provide(FetchHttpClient.layer))), Effect.runPromise)

  expect(result.contentType).toContain("application/json")
  expect(JSON.parse(new TextDecoder().decode(result.body)).url).toBe("https://httpbin.org/get")
})
