// Serve-only entrypoint for the `bcode-<target>-serve` binary variant.
//
// `packages/opencode/src/index.ts` eagerly imports all 24 command modules.
// Headless containers only ever invoke `bcode serve`, so registering just that
// one keeps the other 23 out of the bundle — which is what makes bytecode
// compilation affordable for this variant.
//
// Lives here rather than in `packages/opencode` so that tree, forked from
// upstream and synced regularly, stays untouched.
//
// DRIFT WARNING: the global-option and lifecycle wiring below is duplicated
// from `packages/opencode/src/index.ts`, which stays the source of truth.
// Options added there must be mirrored here, and nothing enforces it — the
// build's smoke test boots `serve` for real, which catches a broken module
// graph but not a missing option, since `.strict()` only rejects a flag at the
// moment a caller passes one.

// Must stay the FIRST import: this module sets LMNR_PROJECT_API_KEY as an
// import side effect, before any downstream module-load code reads it. Same
// ordering contract as packages/opencode/src/index.ts.
import "@browser-use/bcode-browser/telemetry"

import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import { EOL } from "os"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ServeCommand } from "@browser-use/browsercode-core/cli/cmd/serve"
import { UI } from "@browser-use/browsercode-core/cli/ui"
import { FormatError } from "@browser-use/browsercode-core/cli/error"
import { errorMessage } from "@browser-use/browsercode-core/util/error"
import { Heap } from "@browser-use/browsercode-core/cli/heap"

const args = hideBin(process.argv)

function show(out: string) {
  const text = out.trimStart()
  if (!text.startsWith("bcode ")) {
    process.stderr.write(UI.logo() + EOL + EOL)
    process.stderr.write(text + EOL)
    return
  }
  process.stderr.write(out)
}

const cli = yargs(args)
  .parserConfiguration({ "populate--": true })
  .scriptName("bcode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .middleware(async (opts) => {
    if (opts.printLogs) process.env.OPENCODE_PRINT_LOGS = "1"
    if (opts.logLevel) process.env.OPENCODE_LOG_LEVEL = opts.logLevel
    if (opts.pure) {
      process.env.OPENCODE_PURE = "1"
    }

    Heap.start()

    process.env.AGENT = "1"
    process.env.OPENCODE = "1"
    process.env.OPENCODE_PID = String(process.pid)
  })
  .usage("")
  .command(ServeCommand)
  .fail((msg, err) => {
    if (
      msg?.startsWith("Unknown argument") ||
      msg?.startsWith("Not enough non-option arguments") ||
      msg?.startsWith("Invalid values:")
    ) {
      if (err) throw err
      cli.showHelp(show)
    }
    if (err) throw err
    process.exit(1)
  })
  .strict()

try {
  if (args.includes("-h") || args.includes("--help")) {
    await cli.parse(args, (err: Error | undefined, _argv: unknown, out: string) => {
      if (err) throw err
      if (!out) return
      show(out)
    })
  } else {
    await cli.parse()
  }
} catch (e) {
  const formatted = FormatError(e)
  if (formatted) UI.error(formatted)
  if (formatted === undefined) {
    UI.error("Unexpected error" + EOL)
    process.stderr.write(errorMessage(e) + EOL)
  }
  process.exitCode = 1
} finally {
  // Single drain point for OTel-based plugins (e.g. bcode-laminar); without it
  // trailing spans are lost. Mirrors the drain in packages/opencode/src/index.ts.
  try {
    const { pluginShutdownHooks } = await import("@browser-use/browsercode-core/plugin/index")
    await Promise.race([
      Promise.allSettled(
        Array.from(pluginShutdownHooks).map((hook) =>
          Promise.resolve()
            .then(hook)
            .catch((err: Error) => console.error("plugin shutdown hook failed", err)),
        ),
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ])
  } catch (err) {
    console.error("plugin shutdown import failed", err)
  }
  // Some subprocesses don't react properly to SIGTERM and similar signals.
  // Explicitly exit to avoid any hanging subprocesses.
  process.exit()
}
