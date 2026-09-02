/**
 * Bounded JSON Schema contracts for graph inputs, transitions, and outputs.
 *
 * Mirrors the reference runtime's `runtime_contracts.py`, including the order
 * in which the checks fire, because the first failing check decides the code a
 * run terminates with.
 */
import Ajv2020 from "ajv/dist/2020.js"
import type { AnyValidateFunction } from "ajv/dist/core.js"
import type { DataSource, JsonSchema, JsonValue } from "@koracode/kcode-workflow-contracts"
import { ContractViolation } from "./errors"
import type { ExecutionContext, InstanceKey } from "./context"
import { isJsonObject, oneOf, pythonJson, sortedKeys } from "./json"

export const MAX_SCHEMA_BYTES = 64 * 1024
export const MAX_SCHEMA_DEPTH = 32
export const MAX_SCHEMA_PROPERTIES = 512
export const MAX_REGEX_LENGTH = 512
export const MAX_INSTANCE_BYTES = 1 * 1024 * 1024

export const forbiddenSchemaKeywords: readonly string[] = ["$dynamicRef", "$dynamicAnchor", "contentSchema"]

const ajv = new Ajv2020({ allErrors: true, strict: false, strictSchema: false, validateFormats: false })
const compiled = new Map<string, AnyValidateFunction>()
const COMPILED_CACHE_LIMIT = 256

function validatorFor(schema: JsonSchema): AnyValidateFunction {
  const key = JSON.stringify(schema)
  const hit = compiled.get(key)
  if (hit) return hit
  const validate = ajv.compile(schema as object)
  if (compiled.size >= COMPILED_CACHE_LIMIT) compiled.clear()
  compiled.set(key, validate)
  return validate
}

function byteLength(value: JsonValue): number {
  return new TextEncoder().encode(pythonJson(value, { compact: true, ensureAscii: false })).byteLength
}

/** Meta-validate one accepted schema under the bounded local-ref profile. */
export function validateSchemaDocument(
  schema: unknown,
  options: { readonly location: string; readonly objectRoot?: boolean; readonly requireSources?: boolean },
): JsonSchema {
  const { location, objectRoot = false, requireSources = false } = options
  if (!isJsonObject(schema)) throw new ContractViolation("SCHEMA_NOT_OBJECT", location)
  let size: number
  try {
    size = byteLength(schema)
  } catch {
    throw new ContractViolation("SCHEMA_NOT_JSON", location)
  }
  if (size > MAX_SCHEMA_BYTES) throw new ContractViolation("SCHEMA_TOO_LARGE", location)
  if (objectRoot && schema["type"] !== "object") throw new ContractViolation("SCHEMA_ROOT_NOT_OBJECT", location)
  walkSchema(schema, location, 0)
  if (!ajv.validateSchema(schema as object, false)) throw new ContractViolation("SCHEMA_INVALID", location)
  if (requireSources) validatePropertySources(schema, location)
  return schema as JsonSchema
}

function walkSchema(value: unknown, location: string, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new ContractViolation("SCHEMA_TOO_DEEP", location)
  if (Array.isArray(value)) {
    value.forEach((child) => walkSchema(child, location, depth + 1))
    return
  }
  if (!isJsonObject(value)) return
  const properties = value["properties"]
  if (isJsonObject(properties) && Object.keys(properties).length > MAX_SCHEMA_PROPERTIES) {
    throw new ContractViolation("SCHEMA_TOO_MANY_PROPERTIES", location)
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenSchemaKeywords.includes(key)) throw new ContractViolation("SCHEMA_KEYWORD_FORBIDDEN", location)
    if (key === "$ref" && (typeof child !== "string" || !child.startsWith("#/"))) {
      throw new ContractViolation("SCHEMA_REF_NOT_LOCAL", location)
    }
    if (key === "pattern" || key === "patternProperties") {
      const patterns = key === "pattern" ? [child] : isJsonObject(child) ? Object.keys(child) : []
      if (patterns.some((pattern) => typeof pattern !== "string" || pattern.length > MAX_REGEX_LENGTH)) {
        throw new ContractViolation("SCHEMA_REGEX_TOO_LONG", location)
      }
    }
    walkSchema(child, location, depth + 1)
  }
}

function validatePropertySources(schema: Readonly<Record<string, JsonValue>>, location: string): void {
  const properties = schema["properties"]
  if (!isJsonObject(properties)) return
  for (const [name, propertySchema] of Object.entries(properties)) {
    if (!isJsonObject(propertySchema) || !("x-source" in propertySchema)) {
      throw new ContractViolation("SCHEMA_SOURCE_REQUIRED", `${location}/properties/${name}`)
    }
    try {
      parseDataSource(propertySchema["x-source"] ?? null)
    } catch {
      throw new ContractViolation("SCHEMA_SOURCE_INVALID", `${location}/properties/${name}`)
    }
  }
}

const dataSourceFields: readonly string[] = ["from", "pointer", "definition_path", "node_id", "edge_id", "selection"]
const dataSourceFrom: readonly DataSource["from"][] = ["run", "previous", "node", "edge"]
const dataSourceSelection: readonly NonNullable<DataSource["selection"]>[] = [
  "single",
  "latest_same_iteration",
  "all_in_scope",
  "current",
]

export class DataSourceError extends Error {}

/** The `x-source` annotation, with the reference model's `extra=forbid` rule. */
export function parseDataSource(value: JsonValue): DataSource {
  if (!isJsonObject(value)) throw new DataSourceError("x-source is not an object")
  for (const key of Object.keys(value)) {
    if (!dataSourceFields.includes(key)) throw new DataSourceError(`unexpected field ${key}`)
  }
  const from = value["from"]
  if (!oneOf(dataSourceFrom, from)) throw new DataSourceError("invalid from")
  const pointer = value["pointer"] ?? ""
  if (typeof pointer !== "string") throw new DataSourceError("pointer must be a string")
  const rawPath = value["definition_path"] ?? []
  if (!Array.isArray(rawPath)) throw new DataSourceError("definition_path must be a list of strings")
  const definitionPath: string[] = []
  for (const segment of rawPath) {
    if (typeof segment !== "string") throw new DataSourceError("definition_path must be a list of strings")
    definitionPath.push(segment)
  }
  const nodeID = value["node_id"] ?? null
  if (nodeID !== null && typeof nodeID !== "string") throw new DataSourceError("node_id must be a string")
  const edgeID = value["edge_id"] ?? null
  if (edgeID !== null && typeof edgeID !== "string") throw new DataSourceError("edge_id must be a string")
  const selection = value["selection"] ?? "single"
  if (!oneOf(dataSourceSelection, selection)) throw new DataSourceError("invalid selection")
  if (from === "node" && !nodeID) throw new DataSourceError("node data sources require node_id")
  if (from === "edge" && !edgeID) throw new DataSourceError("edge data sources require edge_id")
  if ((from === "run" || from === "previous") && (nodeID || edgeID)) {
    throw new DataSourceError(`${from} data sources cannot name a node_id or edge_id`)
  }
  if (selection === "current" && from !== "run" && from !== "previous") {
    throw new DataSourceError("selection=current is valid only for run/previous sources")
  }
  return { from, pointer, definition_path: definitionPath, node_id: nodeID, edge_id: edgeID, selection }
}

/** Validate without coercion; report bounded, value-free locations. */
export function validateInstance(instance: JsonValue, schema: JsonSchema, location: string): JsonValue {
  let size: number
  try {
    size = byteLength(instance)
  } catch {
    throw new ContractViolation("INSTANCE_NOT_JSON", location)
  }
  if (size > MAX_INSTANCE_BYTES) throw new ContractViolation("INSTANCE_TOO_LARGE", location)
  const validate = validatorFor(schema)
  if (validate(instance)) return instance
  const errors = (validate.errors ?? []).map((error) => ({
    instancePointer: error.instancePath,
    schemaPointer: error.schemaPath.startsWith("#") ? error.schemaPath.slice(1) : error.schemaPath,
  }))
  const first = errors.toSorted((left, right) =>
    left.instancePointer === right.instancePointer
      ? left.schemaPointer < right.schemaPointer
        ? -1
        : left.schemaPointer > right.schemaPointer
          ? 1
          : 0
      : left.instancePointer < right.instancePointer
        ? -1
        : 1,
  )[0]
  throw new ContractViolation("INSTANCE_INVALID", location, first?.instancePointer ?? "", first?.schemaPointer ?? "")
}

/**
 * Materialize an object input schema exclusively from declared sources.
 *
 * Properties are resolved in code-point order, matching the reference
 * runtime's `sorted(properties)`, so the rendered document is byte-stable.
 */
export function resolveNodeInputs(
  schema: JsonSchema | null | undefined,
  context: ExecutionContext,
  options: { readonly current: InstanceKey; readonly location: string },
): Readonly<Record<string, JsonValue>> {
  if (schema === null || schema === undefined) return { ...context.runInput }
  const validated = validateSchemaDocument(schema, {
    location: options.location,
    objectRoot: true,
    requireSources: true,
  })
  const properties = validated["properties"]
  const result: Record<string, JsonValue> = {}
  if (isJsonObject(properties)) {
    for (const name of sortedKeys(properties)) {
      const propertySchema = properties[name]
      if (!isJsonObject(propertySchema)) continue
      result[name] = context.resolve(parseDataSource(propertySchema["x-source"] ?? null), options.current)
    }
  }
  validateInstance(result, validated, options.location)
  return result
}

export function validateTransitionPayload(
  payload: JsonValue,
  schema: JsonSchema | null | undefined,
  location: string,
): JsonValue {
  if (schema === null || schema === undefined) return payload
  return validateInstance(payload, validateSchemaDocument(schema, { location, objectRoot: true }), location)
}

export function validateOutput(payload: JsonValue, schema: JsonSchema | null | undefined, location: string): JsonValue {
  if (schema === null || schema === undefined) return payload
  return validateInstance(payload, validateSchemaDocument(schema, { location }), location)
}
