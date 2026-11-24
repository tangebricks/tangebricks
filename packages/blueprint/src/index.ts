export {
  BRICK_ID_PATTERN,
  BlueprintMetadataSchema,
  BlueprintStateSchema,
  BrickEntrySchema,
  BrickIdSchema,
  EDGE_ID_PATTERN,
  ENTITY_NAME_PATTERN,
  ENTITY_RELATION_PATTERN,
  ENUM_VALUE_PATTERN,
  EntityDefinitionSchema,
  EntityFieldSchema,
  IDENTIFIER_PATTERN,
  NODE_ID_PATTERN,
  NodePositionSchema,
  PROJECT_SLUG_PATTERN,
  ProjectSlugSchema,
  SecretRefSchema,
  SecretRefTargetKindSchema,
  SettingValueSchema,
  ViewportSchema,
  WORKFLOW_ID_PATTERN,
  WorkflowEdgeSchema,
  WorkflowNodeSchema,
  WorkflowSchema,
  WorkflowTriggerSchema,
  canonicalizeValue,
  createEmptyBlueprint,
  isValidSecretRefHandle,
  normalizeBlueprintState,
  sortRecordKeys,
  toAssemblerBlueprint,
  toSdkEntity,
} from "./schema.ts";

export type {
  BlueprintMetadata,
  BlueprintState,
  BrickEntry,
  Entity,
  EntityDefinition,
  EntityField,
  NodePosition,
  SecretRef,
  SecretRefTargetKind,
  SettingValue,
  Viewport,
  Workflow,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowTrigger,
} from "./schema.ts";

export {
  AddEntityOpSchema,
  AddNodeOpSchema,
  AddWorkflowOpSchema,
  BindSecretRefOpSchema,
  ConfigureBrickOpSchema,
  ConnectEdgesOpSchema,
  DisconnectEdgeOpSchema,
  EnableBrickOpSchema,
  MetadataPatchSchema,
  NodePatchSchema,
  OP_TYPES,
  OpSchema,
  RemoveBrickOpSchema,
  RemoveEntityOpSchema,
  RemoveNodeOpSchema,
  RemoveWorkflowOpSchema,
  SetIdentityOpSchema,
  SetMetadataOpSchema,
  UnbindSecretRefOpSchema,
  UpdateEntityOpSchema,
  UpdateNodeOpSchema,
  collectOpTargets,
  opTargets,
  primaryTargetForOp,
  targetKey,
} from "./ops.ts";

export type {
  AddEntityOp,
  AddNodeOp,
  AddWorkflowOp,
  BindSecretRefOp,
  ConfigureBrickOp,
  ConnectEdgesOp,
  DisconnectEdgeOp,
  EnableBrickOp,
  Op,
  OpType,
  RemoveBrickOp,
  RemoveEntityOp,
  RemoveNodeOp,
  RemoveWorkflowOp,
  SetIdentityOp,
  SetMetadataOp,
  UnbindSecretRefOp,
  UpdateEntityOp,
  UpdateNodeOp,
} from "./ops.ts";

export { applyOp, applyOps, buildCatalogNodeRegistry } from "./apply.ts";
export type { ApplyOpResult, BlueprintValidationError } from "./apply.ts";

export { computeReadiness } from "./readiness.ts";
export type { ReadinessNeed, ReadinessResult } from "./readiness.ts";

export {
  ActionableIssueSchema,
  DOCUMENTED_ERROR_CODES,
  RemediationOpSchema,
  buildConflictActionableIssues,
  buildDeployBlockerActionableIssue,
  buildRuntimeStepActionableIssue,
  collectBlueprintActionableIssues,
  toActionableIssue,
  toJsonPointerPath,
} from "./issues.ts";
export type {
  ActionableIssue,
  DocumentedErrorCode,
  IssueEnrichmentContext,
  RemediationOp,
} from "./issues.ts";

export {
  evaluateProposalSelection,
  summarizeProposalOps,
} from "./proposals.ts";
export type {
  ProposalActor,
  ProposalRecord,
  ProposalSelectionEvaluation,
  ProposalStatus,
} from "./proposals.ts";

export {
  canonicalCodePayload,
  canonicalGraphPayload,
  canonicalSemanticJson,
  canonicalSemanticPayload,
  computeBlueprintBuildHash,
  computeBlueprintCodeHash,
  computeBlueprintGraphHash,
  semanticHash,
  sha256HexSync,
} from "./hash.ts";

export { computeSemanticDiff } from "./diff.ts";
export type {
  BrickDiffUpdate,
  EntityDiffUpdate,
  EntityFieldDiffUpdate,
  SecretRefDiffUpdate,
  SemanticDiff,
  WorkflowDiffUpdate,
  WorkflowNodeDiffUpdate,
} from "./diff.ts";

export {
  BlueprintExportError,
  buildImportOps,
  exportBlueprintBundle,
  parseBlueprintBundle,
  serializeBlueprintBundle,
  validateBundleNoRawSecrets,
} from "./export.ts";
export type {
  BlueprintBundle,
  ExportedRevisionMeta,
  ParseBlueprintBundleResult,
} from "./export.ts";
