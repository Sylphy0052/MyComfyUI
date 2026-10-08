import { useQuery } from "@tanstack/react-query";

import { apiRequest, type ArtifactRecord, type GenerationJob, type MediaItem } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { ACTIVE_STATES } from "../jobs/useJobs";

/** `GET /generation-jobs`と`GET /media-items`の`limit`の上限。 */
const LIMIT = "200";

type SceneJobs = {
  /** 待機中・実行中のJob。どのシーンのものかは状態の計算側で選ぶ。 */
  active: GenerationJob[];
  /** 統合Jobが出した動画の生成物ID。 */
  composeArtifactIds: Set<string>;
};

function listJobs(params: Record<string, string>): Promise<GenerationJob[]> {
  return apiRequest<GenerationJob[]>(`/generation-jobs?${new URLSearchParams(params)}`);
}

/**
 * Job一覧はシーンで絞れないため、状態 (とProject) で絞って取り、`story_scene_id`で選ぶ。
 * 統合の動画は`/media-items`にJobの種別が無いので、統合Jobの生成物を引いて見分ける。
 */
async function fetchSceneJobs(projectId: string, sceneId: string): Promise<SceneJobs> {
  const [active, succeeded] = await Promise.all([
    Promise.all(ACTIVE_STATES.map((state) => listJobs({ state, order: "desc", limit: LIMIT }))),
    listJobs({ state: "succeeded", project_id: projectId, order: "desc", limit: LIMIT }),
  ]);
  const composeJobs = succeeded.filter((job) => job.kind === "compose" && job.story_scene_id === sceneId);
  const outputs = await Promise.all(
    composeJobs.map((job) => apiRequest<ArtifactRecord[]>(`/artifacts?${new URLSearchParams({ job_id: job.id, kind: "video" })}`)),
  );
  return {
    active: active.flat(),
    composeArtifactIds: new Set(outputs.flat().map((artifact) => artifact.id)),
  };
}

export function useSceneJobs(projectId: string, sceneId: string) {
  return useQuery({
    queryKey: queryKeys.sceneProduceJobs(projectId, sceneId),
    queryFn: () => fetchSceneJobs(projectId, sceneId),
  });
}

/** シーンに紐づく画像・動画・音声。ワークフローとログの記録は除く。 */
export function useSceneMedia(sceneId: string) {
  return useQuery({
    queryKey: queryKeys.sceneProduceMedia(sceneId),
    queryFn: () => {
      const query = new URLSearchParams({ story_scene_id: sceneId, limit: LIMIT });
      query.append("exclude_kind", "workflow");
      query.append("exclude_kind", "log");
      return apiRequest<MediaItem[]>(`/media-items?${query}`);
    },
  });
}

/** キャラ画像の候補を探すための、Projectの未判定の画像。 */
export function useCharacterCandidates(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sceneProduceCharacterMedia(projectId),
    queryFn: () =>
      apiRequest<MediaItem[]>(
        `/media-items?${new URLSearchParams({ kind: "image", project_id: projectId, decision: "undecided", limit: LIMIT })}`,
      ),
    enabled,
  });
}
