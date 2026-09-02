/**
 * Pure hashing.
 *
 * `instructionHash` is the gate that decides whether a node's captured
 * deterministic steps still describe its current instruction. It must match the
 * reference implementation exactly, or a replay silently degrades into a model
 * call and a deterministic case stops being deterministic.
 */
export function sha256Hex(value: string): string {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(value)
  return hash.digest("hex")
}

/** The first 16 hex characters of the instruction's SHA-256. */
export function instructionHash(instruction: string): string {
  return sha256Hex(instruction).slice(0, 16)
}
