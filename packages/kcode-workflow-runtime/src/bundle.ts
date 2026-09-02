/**
 * The immutable, content-addressed recursive definition bundle.
 *
 * A child is always resolved by structured path inside a verified bundle,
 * never by a mutable agent id looked up somewhere else. Every member's bytes
 * are re-verified against their digest on each lookup, so a corrupted store
 * fails the run instead of silently falling back to a live head.
 */
import { canonicalDigest, canonicalize, isWorkflowGraph } from "@koracode/kcode-workflow-contracts"
import type { JsonValue, WorkflowGraphV1 } from "@koracode/kcode-workflow-contracts"
import { DefinitionError } from "./errors"
import { isJsonObject } from "./json"

export const MAX_DEFINITION_DEPTH = 8

export type AssetRecord = {
  readonly node_id: string
  readonly path: string
  readonly digest: string
  readonly bytes: number
}

export type DefinitionMember = {
  readonly path: readonly string[]
  readonly agentId: string
  readonly graph: Readonly<Record<string, JsonValue>>
  readonly globalRules: string
  readonly graphDigest: string
  readonly assets: readonly AssetRecord[]
  readonly sourceVersionId?: string | null
  readonly sourceVersionNumber?: number | null
}

export type DefinitionBundle = {
  readonly rootAgentId: string
  readonly digest: string
  readonly members: readonly DefinitionMember[]
}

export function contentDigest(value: JsonValue): string {
  return canonicalDigest(value)
}

const encoder = new TextEncoder()

function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left)
  const b = encoder.encode(right)
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index += 1) {
    const x = a[index] ?? 0
    const y = b[index] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return a.length - b.length
}

/** The canonical member order the digest is computed over. */
export function orderedMembers(members: readonly DefinitionMember[]): readonly DefinitionMember[] {
  return members.toSorted((left, right) => {
    const shared = Math.min(left.path.length, right.path.length)
    for (let index = 0; index < shared; index += 1) {
      const order = compareUtf8(canonicalize(left.path[index] ?? ""), canonicalize(right.path[index] ?? ""))
      if (order !== 0) return order
    }
    return left.path.length - right.path.length
  })
}

function digestInput(rootAgentId: string, members: readonly DefinitionMember[]): JsonValue {
  return {
    schema_version: 1,
    canonicalization: "RFC8785",
    root_agent_id: rootAgentId,
    members: members.map((member) => ({
      path: [...member.path],
      agent_id: member.agentId,
      version_id: member.sourceVersionId ?? null,
      version_number: member.sourceVersionNumber ?? null,
      graph: member.graph,
      global_rules: member.globalRules,
      graph_digest: member.graphDigest,
      assets: member.assets.map((asset) => ({ ...asset })),
    })),
  }
}

export function definitionBundle(rootAgentId: string, members: readonly DefinitionMember[]): DefinitionBundle {
  const ordered = orderedMembers(members)
  return { rootAgentId, digest: contentDigest(digestInput(rootAgentId, ordered)), members: ordered }
}

/** The manifest a control plane persists: digests only, never the sources. */
export function definitionManifest(bundle: DefinitionBundle): JsonValue {
  return {
    schema_version: 1,
    canonicalization: "RFC8785",
    root_agent_id: bundle.rootAgentId,
    root_digest: bundle.digest,
    members: bundle.members.map((member) => ({
      path: [...member.path],
      agent_id: member.agentId,
      version_id: member.sourceVersionId ?? null,
      version_number: member.sourceVersionNumber ?? null,
      graph_digest: member.graphDigest,
      global_rules_digest: contentDigest(member.globalRules),
      assets: member.assets.map((asset) => ({ ...asset })),
    })),
  }
}

const NUL = String.fromCharCode(0)

/** Recompute a member's script-asset manifest from its graph bytes. */
export function assetManifest(graph: Readonly<Record<string, JsonValue>>): readonly AssetRecord[] {
  const assets: AssetRecord[] = []
  const nodes = graph["nodes"]
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!isJsonObject(node)) continue
    const scripts = node["scripts"]
    for (const script of Array.isArray(scripts) ? scripts : []) {
      if (!isJsonObject(script) || typeof script["source"] !== "string") continue
      const source = script["source"]
      const filename = typeof script["filename"] === "string" ? script["filename"] : ""
      const parts = filename.split("/")
      if (
        !filename ||
        filename.includes(NUL) ||
        filename.includes("\\") ||
        filename.startsWith("/") ||
        parts.some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new DefinitionError("script asset path is invalid")
      }
      assets.push({
        node_id: typeof node["id"] === "string" ? node["id"] : "",
        path: filename,
        digest: sha256Hex(source),
        bytes: encoder.encode(source).byteLength,
      })
    }
  }
  const identities = assets.map((asset) => `${asset.node_id.toLowerCase()} ${asset.path.toLowerCase()}`)
  if (new Set(identities).size !== identities.length) throw new DefinitionError("script asset paths collide by case")
  return assets.toSorted(
    (left, right) => compareUtf8(left.node_id, right.node_id) || compareUtf8(left.path, right.path),
  )
}

function sha256Hex(source: string): string {
  const hash = new Bun.CryptoHasher("sha256")
  hash.update(source)
  return `sha256:${hash.digest("hex")}`
}

function sameAssets(left: readonly AssetRecord[], right: readonly AssetRecord[]): boolean {
  return (
    left.length === right.length &&
    left.every((asset, index) => {
      const other = right[index]
      return (
        other !== undefined &&
        asset.node_id === other.node_id &&
        asset.path === other.path &&
        asset.digest === other.digest &&
        asset.bytes === other.bytes
      )
    })
  )
}

function pathKey(path: readonly string[]): string {
  return JSON.stringify(path)
}

export type GraphValidator = (graph: Readonly<Record<string, JsonValue>>) => boolean

/**
 * Verify the digest, every member's bytes, its paths, and every child binding.
 *
 * `isValidGraph` is injected so the bundle layer stays free of any particular
 * validation policy; the compiler passes the kernel's static validator.
 */
export function verifyDefinitionBundle(
  bundle: DefinitionBundle,
  options: { readonly maxDepth?: number; readonly isValidGraph: GraphValidator },
): void {
  const maxDepth = options.maxDepth ?? MAX_DEFINITION_DEPTH
  if (bundle.digest !== contentDigest(digestInput(bundle.rootAgentId, bundle.members))) {
    throw new DefinitionError("immutable definition digest verification failed")
  }
  const byPath = new Map<string, DefinitionMember>()
  for (const member of bundle.members) {
    const key = pathKey(member.path)
    if (byPath.has(key)) throw new DefinitionError("immutable definition contains a duplicate structured path")
    if (member.path.length > maxDepth) throw new DefinitionError(`definition depth exceeds ${maxDepth}`)
    if (contentDigest(member.graph) !== member.graphDigest) {
      throw new DefinitionError("immutable definition member failed content verification")
    }
    if (!options.isValidGraph(member.graph)) throw new DefinitionError("immutable definition member failed validation")
    if (!sameAssets(assetManifest(member.graph), member.assets)) {
      throw new DefinitionError("immutable definition asset manifest failed verification")
    }
    byPath.set(key, member)
  }
  const root = byPath.get(pathKey([]))
  if (root === undefined || root.agentId !== bundle.rootAgentId) {
    throw new DefinitionError("immutable definition root is absent or mismatched")
  }
  for (const member of byPath.values()) {
    for (const node of subworkflowNodes(member.graph)) {
      const child = byPath.get(pathKey([...member.path, node.id]))
      if (child === undefined || child.agentId !== node.targetAgentId) {
        throw new DefinitionError("immutable definition closure is incomplete")
      }
    }
  }
  for (const member of byPath.values()) {
    if (member.path.length === 0) continue
    const parent = byPath.get(pathKey(member.path.slice(0, -1)))
    if (parent === undefined) throw new DefinitionError("immutable definition contains an orphan path")
    const boundary = member.path[member.path.length - 1]
    const bound = subworkflowNodes(parent.graph).some(
      (node) => node.id === boundary && node.targetAgentId === member.agentId,
    )
    if (!bound) throw new DefinitionError("immutable definition path does not match its parent binding")
  }
}

function subworkflowNodes(
  graph: Readonly<Record<string, JsonValue>>,
): readonly { readonly id: string; readonly targetAgentId: string }[] {
  const nodes = graph["nodes"]
  if (!Array.isArray(nodes)) return []
  return nodes.flatMap((node) => {
    if (!isJsonObject(node) || node["type"] !== "subworkflow") return []
    const id = node["id"]
    const target = node["target_agent_id"]
    if (typeof id !== "string" || typeof target !== "string") return []
    return [{ id, targetAgentId: target }]
  })
}

/** A run-scoped resolver with no live-head dependency. */
export class DefinitionResolver {
  readonly #byPath: ReadonlyMap<string, DefinitionMember>

  constructor(
    readonly bundle: DefinitionBundle,
    options: { readonly isValidGraph: GraphValidator },
  ) {
    verifyDefinitionBundle(bundle, {
      maxDepth: Math.max(0, ...bundle.members.map((member) => member.path.length)),
      isValidGraph: options.isValidGraph,
    })
    this.#byPath = new Map(bundle.members.map((member) => [pathKey(member.path), member]))
  }

  member(path: readonly string[]): DefinitionMember {
    const member = this.#byPath.get(pathKey(path))
    if (member === undefined) {
      throw new DefinitionError("definition path is absent from the immutable run definition")
    }
    if (contentDigest(member.graph) !== member.graphDigest) {
      throw new DefinitionError("immutable definition member failed content verification")
    }
    return member
  }

  root(): WorkflowGraphV1 {
    return asWorkflowGraph(this.member([]).graph)
  }

  globalRules(path: readonly string[]): string {
    return this.member(path).globalRules
  }

  child(parentPath: readonly string[], nodeId: string, targetAgentId: string): WorkflowGraphV1 {
    const member = this.member([...parentPath, nodeId])
    if (member.agentId !== targetAgentId) {
      throw new DefinitionError("subworkflow is absent from the immutable run definition")
    }
    return asWorkflowGraph(member.graph)
  }
}

/**
 * Narrow a verified member to the typed graph, re-checking the wire shape.
 *
 * The bundle already validated every member, so this can only fail if the
 * member changed underneath us — which is exactly when refusing is right.
 */
function asWorkflowGraph(graph: Readonly<Record<string, JsonValue>>): WorkflowGraphV1 {
  if (!isWorkflowGraph(graph)) throw new DefinitionError("immutable definition member is invalid")
  return graph
}
