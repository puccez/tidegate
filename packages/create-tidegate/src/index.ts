export {
  runCreateTidegate,
  type CreateTidegateCliOptions,
} from "./cli.ts";
export {
  DEFAULT_SMOKE_INTERACTION_ID,
  DOCTOR_PING_ACTION_ID,
  runTidegateDoctor,
  type DoctorConfig,
  type DoctorDeps,
  type DoctorFetch,
  type DoctorReport,
  type DoctorStage,
  type DoctorStageStatus,
  type DoctorVisibility,
} from "./doctor.ts";
export {
  registerTidegateActionBackend,
  type RegisterActionBackendConfig,
  type RegisterActionBackendReport,
} from "./register.ts";
export {
  generateBridgeSecret,
  scaffoldTidegateIntegration,
  type PackageManager,
  type ScaffoldFailureReason,
  type ScaffoldOptions,
  type ScaffoldResult,
} from "./scaffold.ts";
