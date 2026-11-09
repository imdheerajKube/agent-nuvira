/**
 * Public surface of the steering control plane.
 *
 * Everything a CLI, dashboard or engine needs is exported here. The Plan Version
 * Store and the scheduler are the only writers of plan state; surfaces use the
 * inbox and approval API.
 */

export * from './types.js';
export { steeringEnabled } from './runtime.js';
export {
  openSteeringRun,
  getSteeringRun,
  currentSteeringRun,
  withSteeringRun,
  withCliSteeringRun,
  completeSteeringRun,
  closeOpenSteeringRuns,
  closeSteeringRun,
  submitSteeringGuidance,
  steeringProjection,
  listSteeringRuns,
  resolveSteeringRun,
  steeringSafePointForLoop,
  steeringSafePointForPipeline,
  SteeringRunHandle,
} from './runtime.js';
export {
  submitGuidance,
  listGuidance,
  getGuidance,
  withdrawGuidance,
  confirmInterpretation,
  findActiveRun,
} from './inbox.js';
export {
  triagePending,
  applyAccepted,
  runSafePoint,
  syncPlanFromEngine,
  pendingGuidanceSummary,
} from './scheduler.js';
export { projectRun, steeringMetrics, changeProof } from './projection.js';
export {
  decide,
  statusForDecision,
  describeEscalations,
  escalationLabel,
  approvalEffectFor,
  ESCALATION_LABELS,
} from './policy.js';
export { runChangeSteward, validateAssessment, fallbackAssessment, deriveFallbackOps } from './steward.js';
export type { StewardGenerate, StewardResult } from './steward.js';
export { discussRun, discussContext } from './discuss.js';
export {
  decideApproval,
  requestApproval,
  expireApprovals,
} from './approvals.js';
export { listBacklog, createBacklogTaskPrompt, setBacklogStatus, addBacklogItem } from './backlog.js';
export {
  latestPlan,
  readPlanVersion,
  findPlanVersionForChange,
  applyPlanOps,
  commitPlan,
  diffPlans,
} from './plan.js';
export { LoopPlanAdapter, PipelinePlanAdapter } from './adapters.js';
export type { LoopPlanStoreLike, PipelineVaultLike } from './adapters.js';
export { prefilterGuidance, scanInjection, detectControl, MAX_GUIDANCE_CHARS } from './prefilter.js';
export {
  steeringRoot,
  listRuns,
  readRun,
  readChanges,
  readApprovals,
  readJournal,
  runStaleness,
} from './store.js';
