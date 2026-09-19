import type { components } from "./schema";
import type {
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
  createJob: (payload: {
    kind: string;
    scene_ref: Record<string, unknown>;
    shot_ref: Record<string, unknown>;
    recipe_id: string;
    inputs: Record<string, unknown>;
  }) =>
    request<GenerationJob>("/generation-jobs", {
      method: "POST",
      body: JSON.stringify({ ...payload, input_refs: [] }),
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

  artifactContentUrl: (artifactId: string) =>
    `${BASE}/artifacts/${encodeURIComponent(artifactId)}/content`,
};
