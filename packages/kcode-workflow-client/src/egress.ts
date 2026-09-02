// Egress pinning — Phase 12.4 steps 7/8.
//
// The managed profile may reach exactly two kinds of hosts: the Kora control
// plane and the configured model endpoints. Everything else throws BEFORE a
// socket opens. This module is the single URL gate for the whole package;
// tools never call fetch directly.

export class EgressDeniedError extends Error {
  constructor(url: string) {
    super(`egress denied: ${safeHostOf(url)} is not on the allowlist`)
    this.name = "EgressDeniedError"
  }
}

function safeHostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return "<unparseable url>"
  }
}

export interface EgressPolicy {
  /** Exact origins (scheme + host + port) requests may target. */
  readonly allowedOrigins: readonly string[]
}

export function policyFromEnv(env: Record<string, string | undefined> = process.env): EgressPolicy {
  const origins: string[] = []
  const controlPlane = env["KORA_CONTROL_PLANE_URL"]
  if (controlPlane) origins.push(new URL(controlPlane).origin)
  for (const extra of (env["KORA_ALLOWED_MODEL_ORIGINS"] ?? "").split(",")) {
    const trimmed = extra.trim()
    if (trimmed) origins.push(new URL(trimmed).origin)
  }
  return { allowedOrigins: origins }
}

export function assertAllowedUrl(url: string, policy: EgressPolicy): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new EgressDeniedError(url)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new EgressDeniedError(url)
  if (parsed.username || parsed.password) throw new EgressDeniedError(url)
  if (!policy.allowedOrigins.includes(parsed.origin)) throw new EgressDeniedError(url)
  return parsed
}

/** fetch() constrained by the policy; redirects are treated as escapes. */
export async function pinnedFetch(url: string, policy: EgressPolicy, init?: RequestInit): Promise<Response> {
  assertAllowedUrl(url, policy)
  const response = await fetch(url, { ...init, redirect: "manual" })
  if (response.status >= 300 && response.status < 400) {
    throw new EgressDeniedError(response.headers.get("location") ?? url)
  }
  return response
}
