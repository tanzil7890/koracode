#!/usr/bin/env bun
//
// Builds the `bcode-<target>-serve` binary variant: registers only `bcode serve`
// and is bytecode-compiled, for headless containers.
//
// Separate from packages/opencode/script/build.ts so that package — forked from
// upstream and synced regularly — stays untouched. Produces additional release
// assets; never writes the standard ones.
//
//   bun run script/build.ts                                  # host target
//   bun run script/build.ts --targets linux-arm64,linux-x64  # cross-compile
//   OPENCODE_RELEASE=1 bun run script/build.ts --targets ...  # archive + upload

import { $ } from "bun"
import path from "path"
import { fileURLToPath } from "url"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const opencode = path.resolve(dir, "../opencode")

// generate.ts chdirs into packages/opencode on import; restore ours so the
// skills bundle's relative specifiers resolve.
const { modelsData } = await import(path.join(opencode, "script/generate.ts"))
process.chdir(dir)

import { Script } from "@opencode-ai/script"
import { createEmbeddedSkillsBundle } from "../../bcode-browser/script/embed-skills.ts"
import opencodePkg from "../../opencode/package.json"

const flag = (name: string) => process.argv.includes(`--${name}`)
const opt = (name: string) => (flag(name) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined)

const host = `${process.platform}-${process.arch}`
const targets = (opt("targets") ?? host)
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean)

const skills = await createEmbeddedSkillsBundle(dir)

await $`rm -rf dist`

// Cross-compiling needs every platform's native artifacts on disk. Both of these
// are in the serve graph — fff-bun via core/filesystem/fff.bun.ts, @parcel/watcher
// via core/filesystem/watcher.ts — and a plain install only fetches the host's.
if (!flag("skip-install")) {
  for (const dep of ["@ff-labs/fff-bun", "@parcel/watcher"] as const) {
    await $`bun install --os="*" --cpu="*" ${dep}@${opencodePkg.dependencies[dep]}`.cwd(opencode)
  }
}

// Boot the server and wait for its banner. `--version` alone would pass with a
// broken server graph.
//
// The timeout has to be a racing rejection, not just a kill: killing the child
// does not end the read loop if any descendant inherited stdout, so a hung
// smoke test would hang the build instead of failing it.
async function smoke(bin: string) {
  const proc = Bun.spawn([bin, "serve", "--port", "0", "--hostname", "127.0.0.1"], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: "smoke-test" },
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  const banner = (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    for (let out = ""; ; ) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`serve exited before listening:\n${out}\n${await new Response(proc.stderr).text()}`)
      out += decoder.decode(value, { stream: true })
      if (out.includes("listening on")) return out.trim().split("\n").at(-1)
    }
  })()
  try {
    return await Promise.race([
      banner,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("serve did not print its listening banner within 60s")), 60_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    // SIGKILL, not the default SIGTERM: a wedged child must not outlive us.
    proc.kill("SIGKILL")
    await proc.exited
  }
}

const archives: string[] = []

for (const target of targets) {
  const asset = `bcode-${target}-serve`
  const bin = path.join(dir, "dist", asset, "bin/bcode")
  const musl = /(^|-)musl(-|$)/.test(target)
  console.log(`building ${asset}`)

  const built = await Bun.build({
    conditions: ["bun", "node"],
    // opencode's tsconfig supplies the `@/*` -> packages/opencode/src/* mapping
    // that its own sources rely on.
    tsconfig: path.join(opencode, "tsconfig.json"),
    external: ["node-gyp"],
    format: "esm",
    minify: true,
    sourcemap: "none",
    splitting: true,
    bytecode: !flag("no-bytecode"),
    compile: {
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: true,
      autoloadPackageJson: true,
      target: `bun-${target}` as any,
      outfile: bin,
      execArgv: [`--user-agent=opencode/${Script.version}`, "--use-system-ca", "--"],
      windows: {},
    },
    files: {
      // Hard requirement: skills.ts throws when this is missing in a compiled
      // binary, rather than degrading.
      "bcode-skills.gen.ts": skills,
      // Must stay embedded even though this build ships no web UI. Leaving it
      // out does NOT fail closed: Bun keeps the bare `import("opencode-web-ui.gen.ts")`
      // in server/shared/ui.ts live and resolves it at runtime against the
      // server's cwd. A file planted at ./node_modules/opencode-web-ui.gen.ts
      // then executes in-process, and its default export is used as a path map
      // that serveUIEffect reads and returns over HTTP. PUBLIC_UI_PATHS lets
      // /site.webmanifest and the two manifest icons skip auth entirely, so that
      // read is reachable even with a server password set. An empty stub
      // resolves the specifier hermetically and every UI path 404s, which is
      // what a headless server wants anyway.
      "opencode-web-ui.gen.ts": "export default {}",
    },
    entrypoints: ["./src/index.ts", "bcode-skills.gen.ts", "opencode-web-ui.gen.ts"],
    // Every consumer of these reads them behind a `typeof` guard, so a missing
    // one degrades silently rather than throwing — hence the assertion below.
    define: {
      OPENCODE_VERSION: `'${Script.version}'`,
      OPENCODE_CHANNEL: `'${Script.channel}'`,
      OPENCODE_MODELS_DEV: modelsData,
      // Native-binding selectors: fff-bun and @parcel/watcher each pick their
      // .so by libc, so musl builds must say so or file watching silently dies.
      FFF_LIBC: JSON.stringify(musl ? "musl" : "gnu"),
      OPENCODE_LIBC: target.startsWith("linux-") ? `'${musl ? "musl" : "glibc"}'` : "''",
      // Release CI supplies the key; empty locally. Runtime use is gated in
      // @browser-use/bcode-browser/src/telemetry.ts.
      BCODE_DEFAULT_LMNR_KEY: JSON.stringify(process.env.BCODE_DEFAULT_LMNR_KEY ?? ""),
    },
  })
  if (!built.success) {
    console.error(built.logs)
    process.exit(1)
  }

  if (target === host) {
    const banner = await smoke(bin)
    // Assert a define actually landed. The banner above cannot tell: every
    // define read upstream is `typeof`-guarded, so a dropped one just falls
    // back to a default and the server still starts.
    const version = (await $`${bin} --version`.text()).trim()
    if (version !== Script.version) {
      console.error(`define check failed: --version printed ${version}, expected ${Script.version}`)
      process.exit(1)
    }
    console.log(`smoke: ${banner}`)
  }

  if (Script.release) {
    await $`tar -czf ../../${asset}.tar.gz *`.cwd(`dist/${asset}/bin`)
    archives.push(`./dist/${asset}.tar.gz`)
  }
}

if (Script.release) {
  await $`gh release upload v${Script.version} ${archives} --clobber --repo ${process.env.GH_REPO}`
  console.log(`uploaded: ${archives.join(", ")}`)
}
