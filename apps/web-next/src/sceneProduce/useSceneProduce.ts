import { useQuery } from "@tanstack/react-query";

import { apiRequest, type ArtifactRecord, type GenerationJob, type MediaItem, type Recipe } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { ACTIVE_STATES } from "../jobs/useJobs";

/** `GET /generation-jobs`と`GET /media-items`の`limit`の上限。`URLSearchParams`に渡すので文字列で持つ。 */
const MAX_LIST_LIMIT = "200";

/** 一覧が上限まで返ったか。上限に達した一覧は古いものが切れている。 */
function reachedLimit(list: unknown[]): boolean {
  return list.length >= Number(MAX_LIST_LIMIT);
}

/** 状態の材料。`truncated`は、どれかの一覧が上限に達して一部だけで集計したこと。 */
export type Listed<T> = { items: T; truncated: boolean };

function listJobs(params: Record<string, string>): Promise<GenerationJob[]> {
  return apiRequest<GenerationJob[]>(`/generation-jobs?${new URLSearchParams(params)}`);
}

/**
 * Projectの待機中・実行中のJob。Job一覧はシーンで絞れないため、状態とProjectで絞って取り、
 * どのシーンのものかは状態の計算側で`story_scene_id`から選ぶ。
 */
export function useActiveJobs(projectId: string) {
  return useQuery({
    queryKey: queryKeys.sceneProduceJobs(projectId),
    queryFn: async (): Promise<Listed<GenerationJob[]>> => {
      const lists = await Promise.all(
        ACTIVE_STATES.map((state) => listJobs({ state, project_id: projectId, order: "desc", limit: MAX_LIST_LIMIT })),
      );
      return { items: lists.flat(), truncated: lists.some(reachedLimit) };
    },
  });
}

/**
 * シーンの統合Jobが出した動画の生成物ID。`/media-items`にはJobの種別が無いので、
 * 統合Jobの生成物を引いて動画と見分ける。動画と統合の工程だけが使う。
 */
export function useComposeArtifactIds(projectId: string, sceneId: string) {
  return useQuery({
    queryKey: queryKeys.sceneProduceComposeIds(projectId, sceneId),
    queryFn: async (): Promise<Listed<Set<string>>> => {
      const succeeded = await listJobs({ state: "succeeded", project_id: projectId, order: "desc", limit: MAX_LIST_LIMIT });
      const composeJobs = succeeded.filter((job) => job.kind === "compose" && job.story_scene_id === sceneId);
      const outputs = await Promise.all(
        composeJobs.map((job) =>
          apiRequest<ArtifactRecord[]>(`/artifacts?${new URLSearchParams({ job_id: job.id, kind: "video" })}`),
        ),
      );
      return { items: new Set(outputs.flat().map((artifact) => artifact.id)), truncated: reachedLimit(succeeded) };
    },
  });
}

/** シーンに紐づく画像・動画・音声。ワークフローとログの記録は除く。 */
export function useSceneMedia(sceneId: string) {
  return useQuery({
    queryKey: queryKeys.sceneProduceMedia(sceneId),
    queryFn: async (): Promise<Listed<MediaItem[]>> => {
      const query = new URLSearchParams({ story_scene_id: sceneId, limit: MAX_LIST_LIMIT });
      query.append("exclude_kind", "workflow");
      query.append("exclude_kind", "log");
      const items = await apiRequest<MediaItem[]>(`/media-items?${query}`);
      return { items, truncated: reachedLimit(items) };
    },
  });
}

/** キャラ画像の候補を探すための、登場キャラに紐づく未判定の画像。キャラごとに取る。 */
export function useCharacterCandidates(projectId: string, characterIds: string[], enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.sceneProduceCharacterMedia(projectId, characterIds),
    queryFn: async (): Promise<Listed<MediaItem[]>> => {
      const lists = await Promise.all(
        characterIds.map((characterId) =>
          apiRequest<MediaItem[]>(
            `/media-items?${new URLSearchParams({
              kind: "image",
              project_id: projectId,
              story_character_id: characterId,
              decision: "undecided",
              limit: MAX_LIST_LIMIT,
            })}`,
          ),
        ),
      );
      return { items: lists.flat(), truncated: lists.some(reachedLimit) };
    },
    enabled,
  });
}

/** 統合のRecipe (`kind="compose"`)。台詞の音声・BGMの扱いはRecipeではなく`inputs`で決まるので、先頭を使う。 */
export function useComposeRecipe() {
  return useQuery({
    queryKey: queryKeys.recipes("compose"),
    queryFn: () => apiRequest<Recipe[]>("/recipes?kind=compose"),
    select: (recipes) => recipes[0] ?? null,
  });
}
