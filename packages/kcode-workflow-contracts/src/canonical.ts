import type { JsonValue } from "../contract/generated/workflow-protocol"

export class CanonicalizationError extends Error {
  readonly code = "VALUE_NOT_CANONICALIZABLE"
}

export function canonicalize(value: JsonValue) {
  return encode(value, new Set<object>())
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isJsonRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

export function canonicalDigest(value: JsonValue) {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(canonicalize(value))
  return `sha256:${hash.digest("hex")}`
}

function encode(value: JsonValue, seen: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalizationError()
    return JSON.stringify(value)
  }
  if (seen.has(value)) throw new CanonicalizationError()
  seen.add(value)
  if (Array.isArray(value)) {
    const encoded = `[${value.map((item) => encode(item, seen)).join(",")}]`
    seen.delete(value)
    return encoded
  }
  if (!isJsonRecord(value)) throw new CanonicalizationError()
  const encoded = `{${Object.keys(value)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${encode(value[key] ?? null, seen)}`)
    .join(",")}}`
  seen.delete(value)
  return encoded
}

function isJsonRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
