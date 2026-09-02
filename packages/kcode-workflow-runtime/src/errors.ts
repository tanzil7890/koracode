/**
 * Stable, value-free kernel errors.
 *
 * Every error carries a code and a location and never embeds a resolved value,
 * so a message can be logged or persisted without leaking run data.
 */
export class KernelError extends Error {
  constructor(
    readonly code: string,
    readonly location: string,
    readonly instancePointer = "",
    readonly schemaPointer = "",
  ) {
    super(`${code} at ${location}${instancePointer ? ` (instance ${instancePointer})` : ""}`)
    this.name = "KernelError"
  }
}

/** A JSON Schema document or instance broke the bounded runtime profile. */
export class ContractViolation extends KernelError {
  override readonly name = "ContractViolation"
}

/** A typed data binding could not be resolved deterministically. */
export class DataResolutionError extends KernelError {
  override readonly name = "DataResolutionError"
}

/** An immutable definition failed verification. */
export class DefinitionError extends Error {
  override readonly name = "DefinitionError"
  readonly code = "DEFINITION_INVALID"
}

/** The compiler refused a program before any node could run. */
export class CompileError extends Error {
  override readonly name = "CompileError"
  constructor(
    readonly code: string,
    readonly location: string,
    message?: string,
  ) {
    super(message ?? `${code} at ${location}`)
  }
}
