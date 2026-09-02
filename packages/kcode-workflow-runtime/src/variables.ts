/**
 * The untyped `{{.NAME}}` template layer.
 *
 * This is the reference runtime's `substitute_variables` /
 * `_render_prompt_text` pair. It is pure string work: an unknown name is left
 * verbatim rather than blanked, and a secret name is rewritten to its
 * `##NAME##` placeholder so a prompt never carries a resolved value.
 */
import type { JsonValue } from "@koracode/kcode-workflow-contracts"
import { pythonJson } from "./json"

export const variablePattern = /\{\{\.([A-Z0-9_]+)\}\}/g
export const builtinVariables: readonly string[] = ["PREV_OUTPUT", "ITEM", "ITEM_INDEX"]

export function isBuiltinVariable(name: string): boolean {
  return builtinVariables.includes(name) || (name.startsWith("NODE_") && name.endsWith("_OUTPUT"))
}

export function referencedVariables(text: string): readonly string[] {
  return Array.from(text.matchAll(variablePattern), (match) => match[1]).filter(
    (name): name is string => name !== undefined,
  )
}

/**
 * A non-string value renders as compact JSON, exactly as the reference runtime
 * does, so a prompt built on either side is byte-identical.
 */
export function substituteVariables(instruction: string, values: ReadonlyMap<string, JsonValue>): string {
  return instruction.replace(variablePattern, (whole, name: string) => {
    if (!values.has(name)) return whole
    const value = values.get(name) ?? null
    return typeof value === "string" ? value : pythonJson(value, { compact: true, ensureAscii: false })
  })
}

/**
 * Prompt-safe rendering: plain variables substituted, secret names collapsed to
 * their placeholder. Secret names are replaced after substitution so a secret
 * value can never reach the rendered text.
 */
export function renderPromptText(
  text: string,
  context: ReadonlyMap<string, JsonValue>,
  secretNames: ReadonlySet<string>,
): string {
  // The reference renderer pre-stringifies every non-string value with
  // `sort_keys=True` BEFORE substituting, so a prompt is stable no matter what
  // order a value's keys arrived in.
  const plain = new Map<string, JsonValue>()
  context.forEach((value, name) => {
    if (secretNames.has(name)) return
    plain.set(
      name,
      typeof value === "string" ? value : pythonJson(value, { compact: true, ensureAscii: false, sortKeys: true }),
    )
  })
  let rendered = substituteVariables(text, plain)
  secretNames.forEach((name) => {
    rendered = rendered.split(`{{.${name}}}`).join(`##${name}##`)
  })
  return rendered
}

const secretTokenPattern = /##([A-Z0-9_]+)##/g

export function findSecretTokens(text: string): readonly string[] {
  return Array.from(text.matchAll(secretTokenPattern), (match) => match[1]).filter(
    (name): name is string => name !== undefined,
  )
}
