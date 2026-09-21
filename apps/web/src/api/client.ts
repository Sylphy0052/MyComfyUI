import { apiBaseUrl } from "./base-url";
import type { components } from "./schema";
import type {
  CanonList,
  SceneEnvelope,
  SceneList,
  ShotEnvelope,
  ShotList,
} from "./aimedia";

export type Recipe = components["schemas"]["RecipeRead"];
export type GenerationJob = components["schemas"]["GenerationJobRead"];
export type GenerationManifest =
  components["schemas"]["GenerationManifestRead"];
export type Artifact = components["schemas"]["ArtifactRead"];
export type ArtifactDecision =
  components["schemas"]["ArtifactDecisionUpdate"]["decision"];
export type JobState = GenerationJob["state"];
export type CanonStatus = components["schemas"]["CanonStatusRead"];
export type ReferenceChangeEntry =
  components["schemas"]["ReferenceChangeEntry"];
export type JobLineage = components["schemas"]["JobLineageRead"];
export type AgentProvider = components["schemas"]["AgentProviderRead"];
export type AgentProposal = components["schemas"]["AgentProposalRead"];
export type AgentProposalKind =
  components["schemas"]["AgentProposalCreate"]["kind"];
export type AgentProviderId =
  NonNullable<components["schemas"]["AgentProposalCreate"]["provider_id"]>;
export type AgentProposalState = NonNullable<AgentProposal["state"]>;
export type PlannedOperation = components["schemas"]["PlannedOperation"];
export type ApprovalLog = components["schemas"]["ApprovalLogRead"];
export type AgentDecision =
  components["schemas"]["AgentProposalDecision"]["decision"];
export type VoiceVerification = components["schemas"]["VoiceVerificationRead"];
export type VoiceBackendHealth =
  components["schemas"]["VoiceBackendHealthRead"];
export type VoiceReference = components["schemas"]["VoiceReferenceRead"];
export type ComfyUIBackendHealth =
  components["schemas"]["ComfyUIBackendHealthRead"];
export type ImageReference = components["schemas"]["ImageReferenceRead"];
export type GenerationPreview =
  components["schemas"]["GenerationPreviewRead"];
export type GenerationPreviewDiff =
  components["schemas"]["GenerationPreviewDiff"];
export type Workflow = components["schemas"]["WorkflowRead"];
export type WorkflowVersion = components["schemas"]["WorkflowVersionRead"];
export type ArtifactIntegrity = components["schemas"]["ArtifactIntegrityRead"];
export type ArtifactIntegrityReason =
  components["schemas"]["ArtifactIntegrityFinding"]["reason"];
export type ProjectRecord = components["schemas"]["ProjectRead"];
export type ProjectList = components["schemas"]["ProjectList"];
export type ProjectCreate = components["schemas"]["ProjectCreate"];
export type ProjectUpdate = components["schemas"]["ProjectUpdate"];
export type ProjectGenerationDefaults =
  components["schemas"]["ProjectGenerationDefaults"];
export type ProjectGenerationDefaultsRead =
  components["schemas"]["ProjectGenerationDefaultsRead"];
export type ExternalProjectCandidate =
  components["schemas"]["ExternalProjectCandidate"];
export type ExternalProjectCandidateList =
  components["schemas"]["ExternalProjectCandidateList"];
export type ExternalProjectImport =
  components["schemas"]["ExternalProjectImport"];
export type ProjectSyncPreview =
  components["schemas"]["ProjectSyncPreview"];
export type ProjectSyncApply = components["schemas"]["ProjectSyncApply"];
export type ProjectDeletionImpact =
  components["schemas"]["ProjectDeletionImpact"];
export type SceneCreate = components["schemas"]["SceneCreate"];
export type SceneUpdate = components["schemas"]["SceneUpdate"];
export type ShotCreate = components["schemas"]["ShotCreate"];
export type ShotUpdate = components["schemas"]["ShotUpdate"];
export type StructureDeletionImpact =
  components["schemas"]["StructureDeletionImpact"];
export type ProjectProgress = components["schemas"]["ProjectProgress"];
export type AssignmentTarget = components["schemas"]["AssignmentTarget"];
export type ArtifactBatchOperation =
  components["schemas"]["ArtifactBatchOperation"];
export type ProjectTemplate = components["schemas"]["ProjectTemplateRead"];
export type ProjectPackage = components["schemas"]["ProjectPackage"];
export type ProjectPackagePreflight =
  components["schemas"]["ProjectPackagePreflight"];

/**
 * API が返す共通 Envelope。表示文言ではなく code で種別を判定する (ADR 0001)。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly requestId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: unknown,
    requestId: string | null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

// 接続先は実行時に決まる (Issue #64)。ビルド時定数へは焼き込まない。
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new ApiError(
      0,
      "NETWORK_ERROR",
      "Application API へ接続できません。起動しているか確認してください。",
      String(cause),
      null,
    );
  }
  if (!response.ok) {
    let code = "UNKNOWN";
    let message = `API がエラーを返しました (HTTP ${response.status})`;
    let details: unknown = null;
    let requestId: string | null = null;
    try {
      const body = await response.json();
      if (body && typeof body === "object") {
        code = typeof body.code === "string" ? body.code : code;
        message = typeof body.message === "string" ? body.message : message;
        details = body.details ?? null;
        requestId = typeof body.request_id === "string" ? body.request_id : null;
      }
    } catch {
      // Envelope を取れない応答もそのまま扱う。status だけで種別を判断する。
    }
    throw new ApiError(response.status, code, message, details, requestId);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export const api = {
  listRecipes: (kind?: string) => {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return request<Recipe[]>(`/recipes${query}`);
  },

  listProjects: (params?: {
    lifecycle?: "active" | "archived" | "trashed";
    query?: string;
    sourceType?: "local" | "external";
    favoriteOnly?: boolean;
    sort?: "name" | "created" | "updated" | "last_used";
  }) => {
    const query = new URLSearchParams();
    if (params?.lifecycle) query.set("lifecycle", params.lifecycle);
    if (params?.query) query.set("q", params.query);
    if (params?.sourceType) query.set("source_type", params.sourceType);
    if (params?.favoriteOnly) query.set("favorite_only", "true");
    if (params?.sort) query.set("sort", params.sort);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<ProjectList>(`/projects${suffix}`);
  },

  getProject: (projectId: string) =>
    request<ProjectRecord>(`/projects/${encodeURIComponent(projectId)}`),

  createProject: (payload: ProjectCreate) =>
    request<ProjectRecord>("/projects", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listExternalProjectCandidates: () =>
    request<ExternalProjectCandidateList>("/projects/external-candidates"),

  importExternalProject: (payload: ExternalProjectImport) =>
    request<ProjectRecord>("/projects/import", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  previewProjectSync: (projectId: string) =>
    request<ProjectSyncPreview>(
      `/projects/${encodeURIComponent(projectId)}/sync/preview`,
      { method: "POST" },
    ),

  syncProject: (projectId: string, payload: ProjectSyncApply) =>
    request<ProjectRecord>(`/projects/${encodeURIComponent(projectId)}/sync`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  updateProjectSyncSettings: (projectId: string, autoSync: boolean) =>
    request<ProjectRecord>(
      `/projects/${encodeURIComponent(projectId)}/sync-settings`,
      { method: "PATCH", body: JSON.stringify({ auto_sync: autoSync }) },
    ),

  updateProject: (projectId: string, payload: ProjectUpdate) =>
    request<ProjectRecord>(`/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  getProjectGenerationDefaults: (projectId: string) =>
    request<ProjectGenerationDefaultsRead>(
      `/projects/${encodeURIComponent(projectId)}/generation-defaults`,
    ),

  updateProjectGenerationDefaults: (
    projectId: string,
    payload: ProjectGenerationDefaults,
  ) =>
    request<ProjectGenerationDefaultsRead>(
      `/projects/${encodeURIComponent(projectId)}/generation-defaults`,
      { method: "PUT", body: JSON.stringify(payload) },
    ),

  archiveProject: (projectId: string) =>
    request<ProjectRecord>(
      `/projects/${encodeURIComponent(projectId)}/archive`,
      { method: "POST" },
    ),

  restoreProject: (projectId: string) =>
    request<ProjectRecord>(
      `/projects/${encodeURIComponent(projectId)}/restore`,
      { method: "POST" },
    ),

  touchProject: (projectId: string) =>
    request<ProjectRecord>(
      `/projects/${encodeURIComponent(projectId)}/touch`,
      { method: "POST" },
    ),

  getProjectDeletionImpact: (projectId: string) =>
    request<ProjectDeletionImpact>(
      `/projects/${encodeURIComponent(projectId)}/deletion-impact`,
    ),

  trashProject: (projectId: string, confirm = false) =>
    request<ProjectRecord>(
      `/projects/${encodeURIComponent(projectId)}?confirm=${String(confirm)}`,
      { method: "DELETE" },
    ),

  listProjectTemplates: () =>
    request<ProjectTemplate[]>("/project-portability/templates"),

  createProjectTemplate: (
    projectId: string,
    payload: { name: string; description?: string | null },
  ) =>
    request<ProjectTemplate>(
      `/project-portability/projects/${encodeURIComponent(projectId)}/templates`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  instantiateProjectTemplate: (
    templateId: string,
    payload: { name: string; project_id?: string | null },
  ) =>
    request<ProjectRecord>(
      `/project-portability/templates/${encodeURIComponent(templateId)}/instantiate`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  cloneProject: (
    projectId: string,
    payload: {
      name: string;
      project_id?: string | null;
      include_structure: boolean;
      include_artifact_references: boolean;
    },
  ) =>
    request<ProjectRecord>(
      `/project-portability/projects/${encodeURIComponent(projectId)}/clone`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  exportProjectPackage: (
    projectId: string,
    options?: { includeStructure?: boolean; includeArtifacts?: boolean; includeArtifactFiles?: boolean },
  ) => {
    const backup = options?.includeArtifactFiles === true;
    const query = new URLSearchParams();
    if (!backup) {
      query.set("include_structure", String(options?.includeStructure ?? true));
      query.set("include_artifacts", String(options?.includeArtifacts ?? true));
    }
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<ProjectPackage>(
      `/project-portability/projects/${encodeURIComponent(projectId)}/${backup ? "backup" : "export"}${suffix}`,
    );
  },

  previewProjectPackage: (payload: {
    package: Record<string, unknown>;
    name?: string | null;
    project_id?: string | null;
    path_remap?: Record<string, string>;
  }) =>
    request<ProjectPackagePreflight>("/project-portability/import/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  importProjectPackage: (
    payload: {
      package: Record<string, unknown>;
      name?: string | null;
      project_id?: string | null;
      path_remap?: Record<string, string>;
    },
    restore = false,
  ) =>
    request<ProjectRecord>(`/project-portability/${restore ? "restore" : "import"}`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listScenes: (projectId: string) =>
    request<SceneList>(`/projects/${encodeURIComponent(projectId)}/scenes`),

  getScene: (projectId: string, sceneId: string) =>
    request<SceneEnvelope>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`,
    ),

  createScene: (projectId: string, payload: SceneCreate) =>
    request<SceneEnvelope>(
      `/projects/${encodeURIComponent(projectId)}/scenes`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  updateScene: (projectId: string, sceneId: string, payload: SceneUpdate) =>
    request<SceneEnvelope>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    ),

  reorderScenes: (projectId: string, ids: string[]) =>
    request<SceneList>(
      `/projects/${encodeURIComponent(projectId)}/scenes/reorder`,
      { method: "POST", body: JSON.stringify({ ids }) },
    ),

  getSceneDeletionImpact: (projectId: string, sceneId: string) =>
    request<StructureDeletionImpact>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/deletion-impact`,
    ),

  deleteScene: (projectId: string, sceneId: string, confirm = false) =>
    request<{ id: string; deleted_at: string }>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}?confirm=${String(confirm)}`,
      { method: "DELETE" },
    ),

  listShots: (projectId: string, sceneId: string) =>
    request<ShotList>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/shots`,
    ),

  getShot: (projectId: string, sceneId: string, shotId: string) =>
    request<ShotEnvelope>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}` +
        `/shots/${encodeURIComponent(shotId)}`,
    ),

  createShot: (projectId: string, sceneId: string, payload: ShotCreate) =>
    request<ShotEnvelope>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/shots`,
      { method: "POST", body: JSON.stringify(payload) },
    ),

  updateShot: (
    projectId: string,
    sceneId: string,
    shotId: string,
    payload: ShotUpdate,
  ) =>
    request<ShotEnvelope>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/shots/${encodeURIComponent(shotId)}`,
      { method: "PATCH", body: JSON.stringify(payload) },
    ),

  reorderShots: (projectId: string, sceneId: string, ids: string[]) =>
    request<ShotList>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/shots/reorder`,
      { method: "POST", body: JSON.stringify({ ids }) },
    ),

  getShotDeletionImpact: (
    projectId: string,
    sceneId: string,
    shotId: string,
  ) =>
    request<StructureDeletionImpact>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/shots/${encodeURIComponent(shotId)}/deletion-impact`,
    ),

  deleteShot: (
    projectId: string,
    sceneId: string,
    shotId: string,
    confirm = false,
  ) =>
    request<{ id: string; deleted_at: string }>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/shots/${encodeURIComponent(shotId)}?confirm=${String(confirm)}`,
      { method: "DELETE" },
    ),

  getProjectProgress: (projectId: string) =>
    request<ProjectProgress>(
      `/projects/${encodeURIComponent(projectId)}/progress`,
    ),

  listJobs: (params: {
    projectId?: string;
    sceneId?: string;
    shotId?: string;
    unassigned?: boolean;
  }) => {
    const query = new URLSearchParams();
    if (params.projectId) query.set("project_id", params.projectId);
    if (params.sceneId) query.set("scene_id", params.sceneId);
    if (params.shotId) query.set("shot_id", params.shotId);
    if (params.unassigned) query.set("unassigned", "true");
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<GenerationJob[]>(`/generation-jobs${suffix}`);
  },

  // queue_sequence は Application API が採番する。画面からは指定しない。
  // Scene/Shot/Canon の不変参照も Application API が参照 API から解決するため、
  // 画面が送るのは ID だけとする (Issue #9)。
  createJob: (payload: {
    kind: string;
    project_id?: string | null;
    scene_id?: string | null;
    shot_id?: string | null;
    recipe_id?: string | null;
    use_inherited_defaults?: boolean;
    inputs: Record<string, unknown>;
  }) =>
    request<GenerationJob>("/generation-jobs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // 投入前の確認。Job も Manifest も Artifact も作らない (Issue #41)。
  previewJob: (payload: {
    kind: string;
    project_id?: string | null;
    scene_id?: string | null;
    shot_id?: string | null;
    recipe_id?: string | null;
    use_inherited_defaults?: boolean;
    inputs: Record<string, unknown>;
  }) =>
    request<GenerationPreview>("/generation-jobs/preview", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  cancelJob: (jobId: string) =>
    request<GenerationJob>(
      `/generation-jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
    ),

  updateJobAssignment: (
    jobId: string,
    payload: AssignmentTarget & { include_artifacts?: boolean },
  ) =>
    request<GenerationJob>(
      `/generation-jobs/${encodeURIComponent(jobId)}/assignment`,
      { method: "PATCH", body: JSON.stringify(payload) },
    ),

  listJobArtifacts: (jobId: string) =>
    request<Artifact[]>(
      `/generation-jobs/${encodeURIComponent(jobId)}/artifacts`,
    ),

  getManifest: (manifestId: string) =>
    request<GenerationManifest>(
      `/generation-manifests/${encodeURIComponent(manifestId)}`,
    ),

  updateDecision: (artifactId: string, decision: ArtifactDecision) =>
    request<Artifact>(
      `/artifacts/${encodeURIComponent(artifactId)}/decision`,
      { method: "PATCH", body: JSON.stringify({ decision }) },
    ),

  operateArtifacts: (payload: ArtifactBatchOperation) =>
    request<Artifact[]>("/artifacts/batch-operation", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // tag は複数指定でき、すべてのタグが付いた Artifact だけが返る (AND)。
  // lineage_* は祖先と子孫の両方向を辿った結果へ絞る。
  listArtifacts: (params: {
    projectId?: string;
    sceneId?: string;
    shotId?: string;
    unassigned?: boolean;
    jobId?: string;
    kind?: string;
    decision?: string;
    availability?: string;
    tags?: string[];
    lineageArtifactId?: string;
    lineageJobId?: string;
    limit?: number;
    offset?: number;
  }) => {
    const query = new URLSearchParams();
    if (params.projectId) query.set("project_id", params.projectId);
    if (params.sceneId) query.set("scene_id", params.sceneId);
    if (params.shotId) query.set("shot_id", params.shotId);
    if (params.unassigned) query.set("unassigned", "true");
    if (params.jobId) query.set("job_id", params.jobId);
    if (params.kind) query.set("kind", params.kind);
    if (params.decision) query.set("decision", params.decision);
    if (params.availability) query.set("availability", params.availability);
    for (const tag of params.tags ?? []) query.append("tag", tag);
    if (params.lineageArtifactId)
      query.set("lineage_artifact_id", params.lineageArtifactId);
    if (params.lineageJobId) query.set("lineage_job_id", params.lineageJobId);
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<Artifact[]>(`/artifacts${suffix}`);
  },

  // limit/offset は判定する対象の範囲であり、返る件数ではない。対象が残っている
  // ときは truncated が true になる。include_canon を false にすると参照 API を
  // 引かず、canon_available も false になる。
  listArtifactIntegrity: (params: {
    projectId?: string;
    sceneId?: string;
    shotId?: string;
    unassigned?: boolean;
    jobId?: string;
    kind?: string;
    tags?: string[];
    reasons?: ArtifactIntegrityReason[];
    includeCanon?: boolean;
    limit?: number;
    offset?: number;
  }) => {
    const query = new URLSearchParams();
    if (params.projectId) query.set("project_id", params.projectId);
    if (params.sceneId) query.set("scene_id", params.sceneId);
    if (params.shotId) query.set("shot_id", params.shotId);
    if (params.unassigned) query.set("unassigned", "true");
    if (params.jobId) query.set("job_id", params.jobId);
    if (params.kind) query.set("kind", params.kind);
    for (const tag of params.tags ?? []) query.append("tag", tag);
    for (const reason of params.reasons ?? []) query.append("reason", reason);
    if (params.includeCanon !== undefined)
      query.set("include_canon", String(params.includeCanon));
    if (params.limit) query.set("limit", String(params.limit));
    if (params.offset) query.set("offset", String(params.offset));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<ArtifactIntegrity>(`/artifacts/integrity${suffix}`);
  },

  // 付け直しは成功として扱われる。外すときは付いていないタグの指定が 404 になる。
  addArtifactTag: (artifactId: string, tag: string) =>
    request<Artifact>(`/artifacts/${encodeURIComponent(artifactId)}/tags`, {
      method: "POST",
      body: JSON.stringify({ tag }),
    }),

  // 削除は 204 を返す。更新後の Artifact は呼び出し側で引き直す。
  removeArtifactTag: (artifactId: string, tag: string) =>
    request<void>(
      `/artifacts/${encodeURIComponent(artifactId)}/tags/${encodeURIComponent(tag)}`,
      { method: "DELETE" },
    ),

  listWorkflows: (params?: { kind?: string; engine?: string }) => {
    const query = new URLSearchParams();
    if (params?.kind) query.set("kind", params.kind);
    if (params?.engine) query.set("engine", params.engine);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<Workflow[]>(`/workflows${suffix}`);
  },

  listWorkflowVersions: (workflowId: string) =>
    request<WorkflowVersion[]>(
      `/workflows/${encodeURIComponent(workflowId)}/versions`,
    ),

  getJob: (jobId: string) =>
    request<GenerationJob>(`/generation-jobs/${encodeURIComponent(jobId)}`),

  getCanonStatus: (jobId: string) =>
    request<CanonStatus>(
      `/generation-jobs/${encodeURIComponent(jobId)}/canon-status`,
    ),

  getLineage: (jobId: string) =>
    request<JobLineage>(`/generation-jobs/${encodeURIComponent(jobId)}/lineage`),

  // 当時の条件での再実行。現在 Canon へ暗黙に置き換えられることはない。
  replayJob: (jobId: string) =>
    request<GenerationJob>(
      `/generation-jobs/${encodeURIComponent(jobId)}/replay`,
      { method: "POST" },
    ),

  // 現在 Canon で解決し直した派生 Job を作る。元 Job が親になる。
  regenerateJob: (jobId: string) =>
    request<GenerationJob>(
      `/generation-jobs/${encodeURIComponent(jobId)}/regenerate`,
      { method: "POST" },
    ),

  artifactContentUrl: (artifactId: string) =>
    `${apiBaseUrl()}/artifacts/${encodeURIComponent(artifactId)}/content`,

  listAgentProviders: () => request<AgentProvider[]>("/agent-providers"),

  // 提案の取得は生成 Job を投入しない。投入は承認後の適用だけが行う。
  createAgentProposal: (payload: {
    kind: AgentProposalKind;
    provider_id?: AgentProviderId | null;
    project_id: string;
    scene_id: string;
    shot_id?: string | null;
    recipe_id?: string | null;
    instruction: string;
  }) =>
    request<AgentProposal>("/agent-proposals", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  listAgentProposals: (params: { sceneId?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params.sceneId) query.set("scene_id", params.sceneId);
    if (params.limit) query.set("limit", String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<AgentProposal[]>(`/agent-proposals${suffix}`);
  },

  getAgentProposal: (proposalId: string) =>
    request<AgentProposal>(`/agent-proposals/${encodeURIComponent(proposalId)}`),

  // 承認・却下の記録。承認しただけでは何も実行しない。
  decideAgentProposal: (proposalId: string, decision: AgentDecision) =>
    request<AgentProposal>(
      `/agent-proposals/${encodeURIComponent(proposalId)}/decision`,
      { method: "POST", body: JSON.stringify({ decision }) },
    ),

  // 承認済みの提案を実行する。対象や内容が変わっていれば API 側で拒否される。
  applyAgentProposal: (proposalId: string) =>
    request<GenerationJob>(
      `/agent-proposals/${encodeURIComponent(proposalId)}/apply`,
      { method: "POST" },
    ),

  listCanon: (projectId: string, kind?: string) => {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return request<CanonList>(
      `/projects/${encodeURIComponent(projectId)}/canon${query}`,
    );
  },

  // 音声 Job の読み検証。一致しなかったことは Job の失敗ではない。
  listVoiceVerifications: (jobId: string) =>
    request<VoiceVerification[]>(
      `/generation-jobs/${encodeURIComponent(jobId)}/voice-verifications`,
    ),

  getVoiceBackendHealth: () =>
    request<VoiceBackendHealth>("/backends/voice/health"),

  // 参照音声を入力 cache へ取り込む。Voice Canon の source_sha256 と突き合わせる。
  createVoiceReference: (fileName: string, contentBase64: string) =>
    request<VoiceReference>("/voice-references", {
      method: "POST",
      body: JSON.stringify({
        file_name: fileName,
        content_base64: contentBase64,
      }),
    }),

  getComfyUIBackendHealth: () =>
    request<ComfyUIBackendHealth>("/backends/comfyui/health"),

  // 参照画像とガイド音声を入力 cache へ取り込む。Job 投入時はこの参照を指定する。
  createImageReference: (
    fileName: string,
    contentBase64: string,
    mediaType: string,
  ) =>
    request<ImageReference>("/image-references", {
      method: "POST",
      body: JSON.stringify({
        file_name: fileName,
        content_base64: contentBase64,
        media_type: mediaType,
      }),
    }),

  listApprovalLogs: (params: { subjectId?: string; limit?: number }) => {
    const query = new URLSearchParams();
    if (params.subjectId) query.set("subject_id", params.subjectId);
    if (params.limit) query.set("limit", String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<ApprovalLog[]>(`/approval-logs${suffix}`);
  },
};
