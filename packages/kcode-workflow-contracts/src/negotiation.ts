export const supportedReaderVersions = new Set(["v1"] as const)
export const emittedWriterVersion = "v1" as const

export class ProtocolNegotiationError extends Error {
  readonly code = "PROTOCOL_VERSION_UNSUPPORTED"
}

export function negotiateProtocol(offered: readonly string[]) {
  if (offered.includes("v1")) return "v1" as const
  throw new ProtocolNegotiationError()
}
