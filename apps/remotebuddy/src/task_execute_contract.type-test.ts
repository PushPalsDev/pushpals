import type {
  AutonomyJobMetadata,
  BaseTaskExecuteJobParams,
  TaskExecuteJobParams,
  TaskExecutePlanning,
  WorkerRecentJobSummary,
} from "./remotebuddy_main.js";

type WorkerExecuteJobModule = typeof import("../../workerpals/src/execute_job.js");
type InferFallbackValidationCommandsForTestTask =
  WorkerExecuteJobModule["inferFallbackValidationCommandsForTestTask"];

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;
type Assert<T extends true> = T;

type WorkerTaskExecutePlanningContract = Parameters<
  InferFallbackValidationCommandsForTestTask
>[2];

type WorkerRecentJobSummaryContract = {
  jobId: string;
  taskId: string;
  kind: string;
  status: string;
  workerId: string | null;
  summary: string;
  error: string;
  updatedAt: string;
};

type WorkerTaskExecuteJobContractBase = {
  schemaVersion: 2;
  requestId: string;
  sessionId: string;
  instruction: string;
  plannerWorkerInstruction?: string;
  lane: BaseTaskExecuteJobParams["lane"];
  planning: WorkerTaskExecutePlanningContract;
  targetPath?: string;
  path?: string;
  paths?: string[];
  recentContext: string[];
  recentJobs: WorkerRecentJobSummaryContract[];
};

type WorkerTaskExecuteJobContract =
  | (WorkerTaskExecuteJobContractBase & {
      origin: "user";
      autonomy?: undefined;
    })
  | (WorkerTaskExecuteJobContractBase & {
      origin: "autonomy";
      autonomy: AutonomyJobMetadata;
    });

type _WorkerPlanningContractTest = Assert<
  Equal<TaskExecutePlanning, WorkerTaskExecutePlanningContract>
>;
type _WorkerPayloadContractCoversWorker = Assert<
  TaskExecuteJobParams extends WorkerTaskExecuteJobContract ? true : false
>;
type _WorkerRecentJobsContract = Assert<
  Equal<TaskExecuteJobParams["recentJobs"][number], WorkerRecentJobSummary>
>;
type _WorkerRecentJobsSatisfyContract = Assert<
  WorkerRecentJobSummary extends WorkerRecentJobSummaryContract ? true : false
>;
type _WorkerUserOriginContract = Assert<
  Equal<
    Extract<TaskExecuteJobParams, { origin: "user" }>,
    BaseTaskExecuteJobParams & { origin: "user"; autonomy?: undefined }
  >
>;
type _WorkerAutonomyOriginContract = Assert<
  Equal<
    Extract<TaskExecuteJobParams, { origin: "autonomy" }>,
    BaseTaskExecuteJobParams & { origin: "autonomy"; autonomy: AutonomyJobMetadata }
  >
>;
type _WorkerRecentJobsContractMatch = Assert<
  Equal<WorkerRecentJobSummaryContract, WorkerRecentJobSummary>
>;
type _WorkerRecentJobsRequired = Assert<
  TaskExecuteJobParams extends { recentJobs: WorkerRecentJobSummary[] } ? true : false
>;
type _WorkerRecentJobsRejectOptional = AssertFalse<
  (
    (Omit<BaseTaskExecuteJobParams, "recentJobs"> & {
      recentJobs?: WorkerRecentJobSummary[];
    }) &
      { origin: "user" }
  ) extends TaskExecuteJobParams
    ? true
    : false
>;
type _WorkerUserPayloadAssignable = Assert<
  (BaseTaskExecuteJobParams & { origin: "user" }) extends Extract<
    TaskExecuteJobParams,
    { origin: "user" }
  >
    ? true
    : false
>;
type _WorkerUserPayloadRejectsAutonomy = AssertFalse<
  (
    BaseTaskExecuteJobParams & { origin: "user"; autonomy: AutonomyJobMetadata }
  ) extends TaskExecuteJobParams
    ? true
    : false
>;
type _WorkerAutonomyPayloadAssignable = Assert<
  (BaseTaskExecuteJobParams & {
    origin: "autonomy";
    autonomy: AutonomyJobMetadata;
  }) extends Extract<TaskExecuteJobParams, { origin: "autonomy" }>
    ? true
    : false
>;
type _WorkerAutonomyRequiresMetadata = AssertFalse<
  (
    Omit<BaseTaskExecuteJobParams, "recentJobs"> & {
      origin: "autonomy";
      autonomy?: undefined;
      recentJobs: WorkerRecentJobSummary[];
    }
  ) extends TaskExecuteJobParams
    ? true
    : false
>;
type _WorkerComponentAreaNarrowing = Assert<
  NonNullable<
    Extract<TaskExecuteJobParams, { origin: "autonomy" }>["autonomy"]["componentArea"]
  > extends AutonomyJobMetadata["componentArea"]
    ? true
    : false
>;

export {};
