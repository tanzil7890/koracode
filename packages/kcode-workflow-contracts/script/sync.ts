import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

const packageRoot = resolve(import.meta.dir, "..")
const defaultSource = resolve(packageRoot, "../../..", "contracts/workflow")
const source = process.env.KORA_WORKFLOW_CONTRACT_ROOT
  ? resolve(process.env.KORA_WORKFLOW_CONTRACT_ROOT)
  : defaultSource
const target = resolve(packageRoot, "contract")
const check = process.argv.includes("--check")

if (!(await Bun.file(resolve(source, "manifest.json")).exists())) {
  throw new Error(`neutral workflow contract is unavailable at ${source}`)
}

const files = Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: source, onlyFiles: true })).then((items) =>
  items.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
)
const expected = await files
const failures = (
  await Promise.all(
    expected.map(async (relative) => {
      const content = await Bun.file(resolve(source, relative)).text()
      if (!check) {
        await mkdir(dirname(resolve(target, relative)), { recursive: true })
        await Bun.write(resolve(target, relative), content)
        return undefined
      }
      if (!(await Bun.file(resolve(target, relative)).exists())) return relative
      return (await Bun.file(resolve(target, relative)).text()) === content ? undefined : relative
    }),
  )
).filter((relative): relative is string => relative !== undefined)

const owned = JSON.stringify(expected, undefined, 2) + "\n"
if (!check) {
  await mkdir(target, { recursive: true })
  await Bun.write(resolve(target, ".sync-files.json"), owned)
  process.exit(0)
}
if (!(await Bun.file(resolve(target, ".sync-files.json")).exists())) failures.push(".sync-files.json")
else if ((await Bun.file(resolve(target, ".sync-files.json")).text()) !== owned) failures.push(".sync-files.json")
if (failures.length > 0) {
  throw new Error(`generated workflow contract drift: ${failures.join(", ")}`)
}
