/**
 * A pure, hermetic candidate workflow kernel.
 *
 * It compiles an immutable definition bundle and walks its graph, producing a
 * deterministic decision stream, an affirmative terminal, and a typed output.
 * It performs no browser, model, database, filesystem, process, or network
 * work: everything the world has to answer arrives through an injected action
 * port, and everything time-dependent arrives through an injected clock.
 */
export {
  answer,
  normalizeTaskOutcome,
  type ActionOutcome,
  type ActionPort,
  type ActionRequest,
  type ActionSite,
  type AgentRequest,
  type CheckKind,
  type CheckOutcome,
  type ConditionRequest,
  type EdgeChoice,
  type LoopItemRequest,
  type ReplayOutcome,
  type ReplayRequest,
  type ReplayStep,
  type TaskOutcome,
  type TransitionOutcome,
  type TransitionRequest,
  type VerificationRequest,
} from "./actions"
export { instructionHash, sha256Hex } from "./hash"
export {
  DefinitionResolver,
  MAX_DEFINITION_DEPTH,
  assetManifest,
  contentDigest,
  definitionBundle,
  definitionManifest,
  orderedMembers,
  verifyDefinitionBundle,
  type AssetRecord,
  type DefinitionBundle,
  type DefinitionMember,
  type GraphValidator,
} from "./bundle"
export {
  compile,
  graphDigest,
  preflight,
  type CompileOptions,
  type CompiledProgram,
  type PreflightIssue,
  type PreflightResult,
} from "./compile"
export {
  MAX_INSTANCE_BYTES,
  MAX_REGEX_LENGTH,
  MAX_SCHEMA_BYTES,
  MAX_SCHEMA_DEPTH,
  MAX_SCHEMA_PROPERTIES,
  forbiddenSchemaKeywords,
  parseDataSource,
  resolveNodeInputs,
  validateInstance,
  validateOutput,
  validateSchemaDocument,
  validateTransitionPayload,
} from "./contracts"
export {
  ExecutionContext,
  edgeKey,
  edgeLocation,
  instanceKey,
  instanceLocation,
  resolveJsonPointer,
  type EdgeKey,
  type InstanceKey,
} from "./context"
export { CompileError, ContractViolation, DataResolutionError, DefinitionError, KernelError } from "./errors"
export {
  DecisionEventLog,
  MAX_EVENTS_PER_RUN,
  MAX_TEXT_LEN,
  definitionNodeKey,
  fixedClock,
  steppingClock,
  type Clock,
  type EventPayload,
} from "./events"
export {
  asString,
  compareCodePoints,
  containsIntegralFloatAmbiguity,
  deepFreeze,
  isJsonObject,
  jsonEquals,
  oneOf,
  orEmpty,
  preview,
  pythonJson,
  pythonRepr,
  pythonStr,
  pythonStringRepr,
  pythonTruthy,
  sortedKeys,
  truncateStrings,
  type JsonObject,
  type PythonJsonOptions,
} from "./json"
export {
  DEFAULT_MAX_GRAPH_STEPS,
  MAX_SUBWORKFLOW_DEPTH,
  NODE_LOG_CAP,
  SCOPED_PREAMBLE,
  SECRET_PREAMBLE,
  parseItems,
  runWorkflow,
  runWorkflowGraph,
  walkGraph,
  type NodeLogLine,
  type NodeState,
  type RunOptions,
  type RunResult,
  type RunSite,
  type RuntimeFlags,
  type WalkResult,
} from "./machine"
export {
  TerminalContractError,
  TerminationReason,
  asTerminationReason,
  isTerminationReason,
  outcomeLabelFor,
  runTerminationReason,
  terminationReasons,
  validateTerminalPair,
  type LifecycleStatus,
} from "./terminal"
export {
  GRAPH_VERSION,
  acceptsGraph,
  capabilityCatalog,
  extractVariables,
  handoffSlug,
  knownNodeTypes,
  taskNodeTypes,
  transitionEdgeKinds,
  upgradeGraph,
  validateGraph,
  type GraphIssue,
  type GraphValidation,
  type ValidateOptions,
} from "./validate"
export {
  builtinVariables,
  findSecretTokens,
  isBuiltinVariable,
  referencedVariables,
  renderPromptText,
  substituteVariables,
  variablePattern,
} from "./variables"
