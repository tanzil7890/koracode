/**
 * Pure JSON value helpers.
 *
 * Everything here is total and side-effect free: no clock, no randomness, no
 * host object access. `pythonJson` reproduces CPython's `json.dumps` under
 * each of the option sets the reference runtime actually uses, because those
 * rendered bytes reach prompt text and stored node output, where the
 * differential compares them.
 */
import type { JsonValue } from "@koracode/kcode-workflow-contracts"

export type JsonObject = { readonly [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * CPython sorts strings by Unicode code point; JavaScript's default comparator
 * sorts by UTF-16 code unit, which reorders astral-plane keys. Every ordering
 * decision in this package uses this comparator so key order matches the
 * reference runtime for the whole Unicode range.
 */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left)
  const rightPoints = Array.from(right)
  const shared = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < shared; index += 1) {
    const a = leftPoints[index]?.codePointAt(0) ?? 0
    const b = rightPoints[index]?.codePointAt(0) ?? 0
    if (a !== b) return a < b ? -1 : 1
  }
  return leftPoints.length - rightPoints.length
}

export function sortedKeys(value: JsonObject): readonly string[] {
  return Object.keys(value).toSorted(compareCodePoints)
}

/** Structural equality over JSON values, insensitive to object key order. */
export function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
    return left.every((item, index) => jsonEquals(item, right[index] ?? null))
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left)
    if (leftKeys.length !== Object.keys(right).length) return false
    return leftKeys.every((key) => key in right && jsonEquals(left[key] ?? null, right[key] ?? null))
  }
  return false
}

/**
 * CPython's `json.dumps`.
 *
 * The defaults are CPython's, not the ones this package happens to use most:
 * spaced separators, ASCII escaping, insertion key order. The reference runtime
 * calls `json.dumps` with three different option sets on three different
 * surfaces — a loop's stored payload, a rendered prompt variable, and a
 * narrowed input document — and each one is observable, so each call site here
 * states which it means.
 *
 * The one representation JSON cannot carry is CPython's int/float distinction:
 * a float that happens to be integral renders as `1.0` there and `1` here.
 * `containsIntegralFloatAmbiguity` is the guard for documents where that would
 * matter.
 */
export type PythonJsonOptions = {
  /** `separators=(",", ":")` instead of the spaced default. */
  readonly compact?: boolean
  /** `ensure_ascii`; CPython's default is true. */
  readonly ensureAscii?: boolean
  /** `sort_keys`. */
  readonly sortKeys?: boolean
}

export function pythonJson(value: JsonValue, options: PythonJsonOptions = {}): string {
  const compact = options.compact ?? false
  const ensureAscii = options.ensureAscii ?? true
  const sortKeys = options.sortKeys ?? false
  const itemSeparator = compact ? "," : ", "
  const keySeparator = compact ? ":" : ": "

  const encode = (item: JsonValue): string => {
    if (item === null) return "null"
    if (typeof item === "boolean") return item ? "true" : "false"
    if (typeof item === "number") {
      if (!Number.isFinite(item)) throw new TypeError("value is not JSON")
      return JSON.stringify(item)
    }
    if (typeof item === "string") return renderString(item, ensureAscii)
    if (Array.isArray(item)) return `[${item.map(encode).join(itemSeparator)}]`
    if (!isJsonObject(item)) throw new TypeError("value is not JSON")
    const keys = sortKeys ? sortedKeys(item) : Object.keys(item)
    return `{${keys.map((key) => `${renderString(key, ensureAscii)}${keySeparator}${encode(item[key] ?? null)}`).join(itemSeparator)}}`
  }
  return encode(value)
}

/**
 * CPython escapes the control range plus `"` and `\`, gives `\b\f\n\r\t`
 * their short forms, and under `ensure_ascii` escapes everything above U+007F,
 * emitting a surrogate pair for an astral code point.
 */
function renderString(value: string, ensureAscii: boolean): string {
  let out = '"'
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (character === '"') out += '\\"'
    else if (character === "\\") out += "\\\\"
    else if (character === "\n") out += "\\n"
    else if (character === "\r") out += "\\r"
    else if (character === "\t") out += "\\t"
    else if (character === "\b") out += "\\b"
    else if (character === "\f") out += "\\f"
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`
    else if (!ensureAscii || code < 0x7f) out += character
    else if (code <= 0xffff) out += `\\u${code.toString(16).padStart(4, "0")}`
    else {
      const offset = code - 0x10000
      const high = 0xd800 + (offset >> 10)
      const low = 0xdc00 + (offset & 0x3ff)
      out += `\\u${high.toString(16)}\\u${low.toString(16)}`
    }
  }
  return `${out}"`
}

/** True when any number in the document is integral but may have been a float. */
export function containsIntegralFloatAmbiguity(value: JsonValue): boolean {
  if (typeof value === "number") return Number.isInteger(value)
  if (Array.isArray(value)) return value.some(containsIntegralFloatAmbiguity)
  if (isJsonObject(value)) return Object.values(value).some((item) => containsIntegralFloatAmbiguity(item ?? null))
  return false
}

/** Recursively freeze a JSON document so a caller cannot mutate run state. */
export function deepFreeze<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((item) => deepFreeze(item))
    Object.freeze(value)
  } else if (isJsonObject(value)) {
    Object.values(value).forEach((item) => deepFreeze(item ?? null))
    Object.freeze(value)
  }
  return value
}

/** A membership test that narrows, so a parser never has to assert. */
export function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value)
}

/**
 * CPython's `str()` and `repr()` for JSON documents.
 *
 * The reference runtime embeds both in surfaces the differential corpus
 * compares: a condition node's summary uses `repr()` on the check value, and
 * every event preview goes through `str()`. Reproducing them is what makes the
 * two engines' node states and event payloads byte-comparable.
 */
export function pythonStr(value: JsonValue): string {
  return typeof value === "string" ? value : pythonRepr(value)
}

export function pythonRepr(value: JsonValue): string {
  if (value === null) return "None"
  if (typeof value === "boolean") return value ? "True" : "False"
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value)
  if (typeof value === "string") return pythonStringRepr(value)
  if (Array.isArray(value)) return `[${value.map((item) => pythonRepr(item ?? null)).join(", ")}]`
  if (!isJsonObject(value)) throw new TypeError("value is not JSON")
  const entries = Object.entries(value).map(([key, item]) => `${pythonStringRepr(key)}: ${pythonRepr(item ?? null)}`)
  return `{${entries.join(", ")}}`
}

/** Single quotes, unless the text contains one and no double quote. */
export function pythonStringRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'"
  let out = quote
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (character === "\\") out += "\\\\"
    else if (character === quote) out += `\\${quote}`
    else if (character === "\n") out += "\\n"
    else if (character === "\r") out += "\\r"
    else if (character === "\t") out += "\\t"
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`
    else out += character
  }
  return out + quote
}

/** `text[: limit - 1] + "…"`, counted in code points as CPython does. */
export function preview(value: JsonValue | undefined, limit = 300): string | null {
  if (value === null || value === undefined) return null
  const text = pythonStr(value)
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit - 1).join("") + "…"
}

/** Truncate every string inside an event payload, as the trace writer does. */
export function truncateStrings(value: JsonValue, limit: number): JsonValue {
  if (typeof value === "string") {
    const points = Array.from(value)
    return points.length <= limit ? value : points.slice(0, limit - 1).join("") + "…"
  }
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item ?? null, limit))
  if (isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncateStrings(item ?? null, limit)]))
  }
  return value
}

/**
 * CPython truthiness for JSON values: empty containers, empty strings, zero,
 * false and null are all falsy. The reference runtime writes `value or ""` in
 * several places, and a candidate that only guarded against null would keep an
 * empty object where the reference keeps an empty string.
 */
export function pythonTruthy(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined || value === false) return false
  if (value === true) return true
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  return Object.keys(value).length > 0
}

/** `value or ""`. */
export function orEmpty(value: JsonValue | undefined): JsonValue {
  return value === undefined || !pythonTruthy(value) ? "" : value
}

/** Read a JSON value as a string without ever stringifying a container. */
export function asString(value: JsonValue | undefined, fallback = ""): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return pythonJson(value)
  return fallback
}
