import { describe, expect, test } from "bun:test";

import {
  buildWorkerTaskDependencyGraph,
  computeCandidateAdjacencyBias,
  pickCandidateWithExploreExploit,
} from "./autonomous_engine";

type GraphBuilderInput = Parameters<typeof buildWorkerTaskDependencyGraph>[0];
type TestSnapshot = GraphBuilderInput["snapshot"];
type TestCandidate = GraphBuilderInput["candidates"][number];

const baseTimestamp = "2024-01-01T00:00:00.000Z";

const buildTestSnapshot = (overrides: Partial<TestSnapshot> = {}): TestSnapshot => ({
  snapshot_id: "snap_graph",
  snapshot_created_at: baseTimestamp,
  snapshot_ttl_ms: 120_000,
  impact_model_version: "impact-v1",
  top_signals: [
    { signal_id: "sig_queue", type: "queue_health", value: 0.9, evidence: "queue p95 elevated" },
  ],
  state_traits: [
    {
      trait_id: "server_queue",
      category: "risk",
      focus: "worker apps/server queue",
      score: 0.82,
      evidence: "apps/server worker saturated",
    },
    {
      trait_id: "client_idle",
      category: "strength",
      focus: "worker apps/client idle",
      score: 0.2,
      evidence: "apps/client worker idle",
    },
  ],
  feedback_priors: [],
  engine_idea_priors: [],
  engine_source_priors: [],
  active_cooldowns: [],
  open_objectives: [
    { objective_id: "obj_server_1", pattern_key: "feature_small::apps/server::queue_health", status: "dispatched" },
    { objective_id: "obj_server_2", pattern_key: "feature_small::apps/server::queue_health", status: "dispatched" },
  ],
  repo_health_flags: {
    is_worktree_dirty: false,
    is_merge_in_progress: false,
    dispatch_lock_held: false,
  },
  dispatch_budget: {
    global_count_last_hour: 6,
    by_type_count_last_hour: { feature_small: 3 },
  },
  ...overrides,
} as TestSnapshot);

const buildCandidate = (overrides: Partial<TestCandidate> = {}): TestCandidate => {
  const base: TestCandidate = {
    id: "cand_base",
    title: "Graph test candidate",
    objective_type: "feature_small",
    problem_statement: "Graph modeling test problem",
    trigger_type: "queue_health",
    component_area: "apps/server",
    target_paths: ["apps/server/src/autonomy.ts"],
    scope: { read_anywhere: false, write_globs: ["apps/server/src/*"] },
    risk_level: "low",
    expected_validation: ["bun run test:root"],
    estimated_effort: "small",
    why_now_signal_ids: [],
    confidence: 0.9,
    vision_alignment_reason: "aligns with snapshot queues",
    vision_section_refs: ["6"],
    feature_hypotheses: [],
    requires_user_input: false,
    question_if_blocked: undefined,
    candidate_created_at: baseTimestamp,
    engine_trial: undefined,
  };
  return {
    ...base,
    ...overrides,
    scope: {
      ...base.scope,
      ...(overrides.scope ?? {}),
    },
  };
};

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));
const queueSignalOf = (snapshot: TestSnapshot): number =>
  clamp01(
    Math.max(
      0,
      ...snapshot.top_signals
        .filter((signal) => signal.type === "queue_health")
        .map((signal) => Number(signal.value ?? 0)),
    ),
  );
const average = (values: number[]): number =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

describe("Worker graph modeling", () => {
  test("surfaces congested edges with tick timestamps", () => {
    const snapshot = buildTestSnapshot();
    const serverCandidate = buildCandidate({
      id: "cand_server_hot",
      target_paths: ["packages/shared/src/queue.ts"],
      scope: { read_anywhere: false, write_globs: ["packages/shared/src/*"] },
    });
    const clientCandidate = buildCandidate({
      id: "cand_client_idle",
      component_area: "apps/client",
      target_paths: ["apps/client/src/queue-panel.ts"],
      scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
    });
    const observedAtMs = Date.UTC(2024, 0, 1, 0, 5, 0);
    const graph = buildWorkerTaskDependencyGraph({
      snapshot,
      candidates: [serverCandidate, clientCandidate],
      maxEdgeAlerts: 6,
      observedAtMs,
    });
    expect(graph.workerTaskEdges.length).toBeGreaterThan(0);
    expect(graph.observedAtMs).toBe(observedAtMs);
    expect(graph.congestedEdges.length).toBeGreaterThan(0);
    const serverEdge = graph.workerTaskEdges.find(
      (edge) => edge.workerId === "apps/server" && edge.taskId === "feature_small",
    );
    expect(serverEdge?.congestion ?? 0).toBeGreaterThan(0.5);
  });

  test("dependency hashing avoids prefix collisions and still flags congestion", () => {
    const snapshot = buildTestSnapshot();
    const hotPath = "packages/shared/src/queue/alpha/node.ts";
    const similarPath = "packages/shared/src/queue/alpha/worker.ts";
    const candidates: TestCandidate[] = [
      buildCandidate({ id: "cand_hot_a", target_paths: [hotPath] }),
      buildCandidate({ id: "cand_hot_b", target_paths: [hotPath] }),
      buildCandidate({ id: "cand_hot_c", target_paths: [similarPath] }),
      buildCandidate({
        id: "cand_client_neighbor",
        component_area: "apps/client",
        target_paths: ["apps/client/src/panels/queue/alpha/node.ts"],
        scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
      }),
    ];
    const graph = buildWorkerTaskDependencyGraph({ snapshot, candidates });
    const dependencyKeys = Object.keys(graph.dependencyDemand);
    const hashedKeys = dependencyKeys.filter((key) => key.includes("#"));
    expect(hashedKeys.length).toBeGreaterThanOrEqual(2);
    const dependencyAlerts = graph.congestedEdges.filter((edge) => edge.edgeType === "task_dependency");
    expect(dependencyAlerts.length).toBeGreaterThan(0);
    for (const alert of dependencyAlerts) {
      const [, depKey] = alert.id.split("->");
      expect(depKey).toBeDefined();
      expect(dependencyKeys).toContain(depKey as string);
    }
  });

  test("builds indexed edges with normalized congestion weights", () => {
    const snapshot = buildTestSnapshot();
    const candidate = buildCandidate({
      id: "cand_weight_norm",
      target_paths: ["packages/shared/src/graph/index.ts"],
      scope: { read_anywhere: false, write_globs: ["packages/shared/src/*"] },
    });
    const graph = buildWorkerTaskDependencyGraph({ snapshot, candidates: [candidate] });
    const workerKey = `${candidate.component_area}::${candidate.objective_type}`;
    const workerEdge = graph.workerTaskEdgeIndex[workerKey];
    expect(workerEdge).toBeDefined();
    const queueSignal = queueSignalOf(snapshot);
    const maxWorkerSamples = Math.max(0, ...graph.workerTaskEdges.map((edge) => edge.samples));
    const workerSamples = maxWorkerSamples > 0 && workerEdge ? workerEdge.samples / maxWorkerSamples : 0;
    const workerLoad = graph.workerLoads[candidate.component_area]?.load ?? 0;
    const taskLoad = graph.taskDemand[candidate.objective_type]?.demand ?? 0;
    const expectedWorkerCongestion = clamp01(
      0.4 * workerLoad + 0.25 * workerSamples + 0.2 * queueSignal + 0.15 * taskLoad,
    );
    expect(workerEdge?.congestion).toBeCloseTo(expectedWorkerCongestion, 5);

    const [dependencyKey] = Object.keys(graph.dependencyDemand);
    expect(dependencyKey).toBeDefined();
    const depEdgeKey = `${candidate.objective_type}::${dependencyKey}`;
    const dependencyEdge = graph.taskDependencyEdgeIndex[depEdgeKey];
    expect(dependencyEdge).toBeDefined();
    const dependencyLoad = graph.dependencyDemand[dependencyKey]?.normalizedLoad ?? 0;
    const workerLoadsForDep =
      graph.dependencyDemand[dependencyKey]?.workerIds.map(
        (workerId) => graph.workerLoads[workerId]?.load ?? 0.35,
      ) ?? [];
    const avgWorkerLoad = workerLoadsForDep.length > 0 ? average(workerLoadsForDep) : 0.35;
    const maxDepSamples = Math.max(0, ...graph.taskDependencyEdges.map((edge) => edge.samples));
    const dependencySamples =
      maxDepSamples > 0 && dependencyEdge ? dependencyEdge.samples / maxDepSamples : 0;
    const expectedDepCongestion = clamp01(
      0.35 * dependencyLoad +
        0.2 * taskLoad +
        0.2 * avgWorkerLoad +
        0.15 * queueSignal +
        0.1 * dependencySamples,
    );
    expect(dependencyEdge?.congestion).toBeCloseTo(expectedDepCongestion, 5);
  });
});

describe("Adjacency bias", () => {
  test("reroutes low-risk jobs toward idle workers", () => {
    const snapshot = buildTestSnapshot();
    const sharedDependency = "packages/shared/src/queue.ts";
    const serverCandidate = buildCandidate({
      id: "cand_server_reroute",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["packages/shared/src/*"] },
    });
    const clientCandidate = buildCandidate({
      id: "cand_client_reroute",
      component_area: "apps/client",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
    });
    const graph = buildWorkerTaskDependencyGraph({ snapshot, candidates: [serverCandidate, clientCandidate] });
    const serverBias = computeCandidateAdjacencyBias(graph, serverCandidate);
    const clientBias = computeCandidateAdjacencyBias(graph, clientCandidate);
    expect(serverBias.workerLoad).toBeGreaterThan(clientBias.workerLoad);
    expect(serverBias.bias).toBeLessThan(clientBias.bias);
    expect(serverBias.bias).toBeLessThan(0);
    expect(clientBias.bias).toBeGreaterThan(0);
  });

  test("dampens reroute bias for medium-risk tasks", () => {
    const snapshot = buildTestSnapshot();
    const sharedDependency = "packages/shared/src/queue.ts";
    const serverCandidate = buildCandidate({
      id: "cand_server_anchor",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["packages/shared/src/*"] },
    });
    const lowRiskClient = buildCandidate({
      id: "cand_client_low_risk_adj",
      component_area: "apps/client",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
      risk_level: "low",
    });
    const mediumRiskClient = buildCandidate({
      id: "cand_client_medium_risk_adj",
      component_area: "apps/client",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
      risk_level: "medium",
    });
    const graph = buildWorkerTaskDependencyGraph({
      snapshot,
      candidates: [serverCandidate, lowRiskClient, mediumRiskClient],
    });
    const lowBias = computeCandidateAdjacencyBias(graph, lowRiskClient);
    const mediumBias = computeCandidateAdjacencyBias(graph, mediumRiskClient);
    expect(lowBias.bias).toBeGreaterThan(mediumBias.bias);
    expect(lowBias.bias).toBeGreaterThan(0);
    expect(mediumBias.bias).toBeGreaterThanOrEqual(0);
  });
});

describe("Planner reroute integration", () => {
  test("favors idle workers for low-risk adjacency", () => {
    const snapshot = buildTestSnapshot();
    const sharedDependency = "packages/shared/src/queue.ts";
    const serverCandidate = buildCandidate({
      id: "cand_server_low_risk",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["packages/shared/src/*"] },
    });
    const clientCandidate = buildCandidate({
      id: "cand_client_low_risk",
      component_area: "apps/client",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
    });
    const graph = buildWorkerTaskDependencyGraph({ snapshot, candidates: [serverCandidate, clientCandidate] });
    const serverBias = computeCandidateAdjacencyBias(graph, serverCandidate);
    const clientBias = computeCandidateAdjacencyBias(graph, clientCandidate);
    const rows = [
      { id: serverCandidate.id, finalScore: clamp01(0.6 + serverBias.bias), noveltyScore: 0.4 },
      { id: clientCandidate.id, finalScore: clamp01(0.58 + clientBias.bias), noveltyScore: 0.4 },
    ];
    const selection = pickCandidateWithExploreExploit({ rows, seed: "planner_low_risk", exploreRate: 0 });
    expect(selection.strategy).toBe("exploit");
    expect(selection.selected?.id).toBe(clientCandidate.id);
  });

  test("keeps higher-risk jobs on saturated workers when guardrails block reroute", () => {
    const snapshot = buildTestSnapshot();
    const sharedDependency = "packages/shared/src/queue.ts";
    const serverCandidate = buildCandidate({
      id: "cand_server_high_risk",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["packages/shared/src/*"] },
      risk_level: "high",
    });
    const clientCandidate = buildCandidate({
      id: "cand_client_high_risk",
      component_area: "apps/client",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
      risk_level: "high",
    });
    const graph = buildWorkerTaskDependencyGraph({ snapshot, candidates: [serverCandidate, clientCandidate] });
    const serverBias = computeCandidateAdjacencyBias(graph, serverCandidate);
    const clientBias = computeCandidateAdjacencyBias(graph, clientCandidate);
    const rows = [
      { id: serverCandidate.id, finalScore: clamp01(0.62 + serverBias.bias), noveltyScore: 0.3 },
      { id: clientCandidate.id, finalScore: clamp01(0.61 + clientBias.bias), noveltyScore: 0.3 },
    ];
    const selection = pickCandidateWithExploreExploit({ rows, seed: "planner_high_risk", exploreRate: 0 });
    expect(selection.selected?.id).toBe(serverCandidate.id);
    expect(clientBias.bias).toBeLessThanOrEqual(0.03);
  });

  test("keeps medium-risk jobs on original worker under congestion guardrails", () => {
    const snapshot = buildTestSnapshot();
    const sharedDependency = "packages/shared/src/queue.ts";
    const serverCandidate = buildCandidate({
      id: "cand_server_medium_guardrail",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["packages/shared/src/*"] },
      risk_level: "medium",
    });
    const clientCandidate = buildCandidate({
      id: "cand_client_medium_guardrail",
      component_area: "apps/client",
      target_paths: [sharedDependency],
      scope: { read_anywhere: false, write_globs: ["apps/client/src/*"] },
      risk_level: "medium",
    });
    const graph = buildWorkerTaskDependencyGraph({ snapshot, candidates: [serverCandidate, clientCandidate] });
    const serverBias = computeCandidateAdjacencyBias(graph, serverCandidate);
    const clientBias = computeCandidateAdjacencyBias(graph, clientCandidate);
    const rows = [
      { id: serverCandidate.id, finalScore: clamp01(0.6 + serverBias.bias), noveltyScore: 0.35 },
      { id: clientCandidate.id, finalScore: clamp01(0.59 + clientBias.bias), noveltyScore: 0.35 },
    ];
    const selection = pickCandidateWithExploreExploit({
      rows,
      seed: "planner_medium_guardrail",
      exploreRate: 0,
    });
    expect(selection.strategy).toBe("exploit");
    expect(selection.selected?.id).toBe(serverCandidate.id);
    expect(clientBias.bias - serverBias.bias).toBeLessThan(0.08);
  });
});
