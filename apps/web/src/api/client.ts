import type { components } from "./schema";
import type {
  CanonList,
  ProjectList,
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

const BASE = "/api/v1";

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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
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
  listRecipes: (kind: string) =>
    request<Recipe[]>(`/recipes?kind=${encodeURIComponent(kind)}`),

  listProjects: () => request<ProjectList>("/projects"),

  listScenes: (projectId: string) =>
    request<SceneList>(`/projects/${encodeURIComponent(projectId)}/scenes`),

  getScene: (projectId: string, sceneId: string) =>
    request<SceneEnvelope>(
      `/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}`,
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

  listJobs: (params: { sceneId?: string; shotId?: string }) => {
    const query = new URLSearchParams();
    if (params.sceneId) query.set("scene_id", params.sceneId);
    if (params.shotId) query.set("shot_id", params.shotId);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<GenerationJob[]>(`/generation-jobs${suffix}`);
  },

  // queue_sequence は Application API が採番する。画面からは指定しない。
  // Scene/Shot/Canon の不変参照も Application API が参照 API から解決するため、
  // 画面が送るのは ID だけとする (Issue #9)。
  createJob: (payload: {
    kind: string;
    project_id: string;
    scene_id: string;
    shot_id: string;
    recipe_id: string;
    inputs: Record<string, unknown>;
  }) =>
    request<GenerationJob>("/generation-jobs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  cancelJob: (jobId: string) =>
    request<GenerationJob>(
      `/generation-jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST" },
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

  listArtifacts: (params: {
    sceneId?: string;
    shotId?: string;
    jobId?: string;
    kind?: string;
    limit?: number;
  }) => {
    const query = new URLSearchParams();
    if (params.sceneId) query.set("scene_id", params.sceneId);
    if (params.shotId) query.set("shot_id", params.shotId);
    if (params.jobId) query.set("job_id", params.jobId);
    if (params.kind) query.set("kind", params.kind);
    if (params.limit) query.set("limit", String(params.limit));
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return request<Artifact[]>(`/artifacts${suffix}`);
  },

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
    `${BASE}/artifacts/${encodeURIComponent(artifactId)}/content`,

  listAgentProviders: () => request<AgentProvider[]>("/agent-providers"),

  // 提案の取得は生成 Job を投入しない。投入は承認後の適用だけが行う。
  createAgentProposal: (payload: {
    kind: AgentProposalKind;
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
