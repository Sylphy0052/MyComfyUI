import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiRequest,
  type ArtifactDecision,
  type ArtifactPurgePreview,
  type ArtifactPurgeResult,
  type ArtifactRecord,
  type GenerationJob,
  type GenerationManifest,
  type MediaItem,
  type StorySceneAdoption,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { notifyError } from "../notifications";
import type { StoryLinks } from "./viewerFilters";

const enc = encodeURIComponent;

/** 一覧の1ページ。スクロールで次のページを読む。 */
export const PAGE_SIZE = 100;
/** 一括操作・完全削除の1回の上限 (`schemas.py`の`ArtifactBatchOperation`と`ArtifactPurgeTarget`)。 */
export const BATCH_MAX = 200;
/** 紐づけの更新は1件ずつなので、並べて送る数を抑える。 */
const PATCH_CONCURRENCY = 6;

export type BatchOperation = "move" | "unassign" | "trash" | "restore";

/** 一括操作の対象。紐づけの付け替えで、Projectが変わるかどうかを判断するのに今のProjectを持つ。 */
export type SelectedArtifact = { id: string; projectId: string | null };

function chunks<T>(items: T[], size = BATCH_MAX): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

/** 同じIDの2件目以降を除く。offset方式のページ送りでは、読む途中で先頭に生成物が増えると同じものが2回入る。 */
function uniqueBy<T>(items: T[], idOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const id = idOf(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** 何回かに分けて送る操作が途中で失敗した。`doneIds`は反映済み、`failedIds`は失敗したか送らなかったID。 */
export class PartialFailureError extends Error {
  readonly doneIds: string[];
  readonly failedIds: string[];

  constructor(error: unknown, doneIds: string[], failedIds: string[]) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "PartialFailureError";
    this.doneIds = doneIds;
    this.failedIds = failedIds;
  }
}

/** 一括操作の失敗を通知する。途中まで反映していれば、その件数も出す。 */
export function notifyBatchError(title: string, error: unknown) {
  const counts =
    error instanceof PartialFailureError && error.doneIds.length > 0
      ? ` (${error.doneIds.length}件は反映済み、${error.failedIds.length}件は未反映)`
      : "";
  notifyError(`${title}${counts}`, error);
}

/**
 * `worker`を同時に`limit`件までで全件に呼び、すべての完了を待つ。
 * 失敗があれば、最初の失敗の内容と成否ごとのIDを`PartialFailureError`で返す。
 */
async function runLimited(ids: string[], limit: number, worker: (id: string) => Promise<unknown>): Promise<void> {
  let next = 0;
  const doneIds: string[] = [];
  const failedIds: string[] = [];
  let firstError: unknown = null;
  const lanes = Array.from({ length: Math.min(limit, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++] as string;
      try {
        await worker(id);
        doneIds.push(id);
      } catch (error) {
        if (failedIds.length === 0) firstError = error;
        failedIds.push(id);
      }
    }
  });
  await Promise.all(lanes);
  if (failedIds.length > 0) throw new PartialFailureError(firstError, doneIds, failedIds);
}

/** 生成物の変更は一覧・ゴミ箱・詳細のどれにも効くので、まとめて取り直す。 */
function useInvalidateArtifacts() {
  const client = useQueryClient();
  return (artifactIds: string[] = []) =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.mediaItems }),
      client.invalidateQueries({ queryKey: queryKeys.artifactLists }),
      ...artifactIds.map((id) => client.invalidateQueries({ queryKey: queryKeys.artifact(id) })),
    ]);
}

// ---- 一覧 ----

/** 画像タブの一覧。`query`は`mediaItemsQuery`で作った絞り込み。 */
export function useViewerImages(query: URLSearchParams) {
  const key = query.toString();
  return useInfiniteQuery({
    queryKey: queryKeys.viewerImages(key),
    queryFn: ({ pageParam }) =>
      apiRequest<MediaItem[]>(
        `/media-items?${new URLSearchParams([...query, ["limit", String(PAGE_SIZE)], ["offset", String(pageParam)]])}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => (lastPage.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE),
    // 入力cacheと人物参照の画像も同じ一覧で返るので、生成物 (Artifact) だけを出す。
    select: (data) =>
      uniqueBy(
        data.pages.flat().filter((item) => item.artifact_id),
        (item) => item.artifact_id as string,
      ),
  });
}

/** ゴミ箱タブの一覧。 */
export function useTrashedArtifacts() {
  return useInfiniteQuery({
    queryKey: queryKeys.trashedArtifacts,
    queryFn: ({ pageParam }) =>
      apiRequest<ArtifactRecord[]>(
        `/artifacts?${new URLSearchParams({ trashed: "true", limit: String(PAGE_SIZE), offset: String(pageParam) })}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => (lastPage.length < PAGE_SIZE ? undefined : pages.length * PAGE_SIZE),
    select: (data) => uniqueBy(data.pages.flat(), (item) => item.id),
  });
}

/** 絞り込みに合う生成物をすべて取る。「不採用をまとめてゴミ箱へ」の対象数えに使う。 */
async function fetchAllMediaItems(query: URLSearchParams): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  for (let offset = 0; ; offset += BATCH_MAX) {
    const page = await apiRequest<MediaItem[]>(
      `/media-items?${new URLSearchParams([...query, ["limit", String(BATCH_MAX)], ["offset", String(offset)]])}`,
    );
    items.push(...page);
    if (page.length < BATCH_MAX) return items;
  }
}

/** `query`に合う不採用の生成物のID。`enabled`の間だけ取る。 */
export function useRejectedArtifactIds(query: URLSearchParams, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.rejectedArtifactIds(query.toString()),
    queryFn: () => fetchAllMediaItems(query),
    select: (items) =>
      items.filter((item) => item.decision === "rejected" && item.artifact_id).map((item) => item.artifact_id as string),
    enabled,
    // 確認ダイアログを開くたびに数え直す。
    gcTime: 0,
  });
}

/** Jobの結果を開くとき (`/viewer?job=`) の対象。Workflowとログは除く。 */
export function useJobArtifact(jobId: string | null) {
  return useQuery({
    queryKey: queryKeys.jobArtifacts(jobId ?? ""),
    queryFn: () =>
      apiRequest<ArtifactRecord[]>(
        `/artifacts?${new URLSearchParams([
          ["job_id", jobId ?? ""],
          ["exclude_kind", "workflow"],
          ["exclude_kind", "log"],
          ["limit", "1"],
        ])}`,
      ),
    enabled: jobId !== null,
    select: (items) => items[0] ?? null,
  });
}

// ---- 詳細 ----

/** 生成設定。生成物のJobからManifestを辿る。取り込んだ画像のようにJobが無ければ`null`。 */
export function useGenerationSettings(jobId: string | null) {
  const job = useQuery({
    queryKey: queryKeys.job(jobId ?? ""),
    queryFn: () => apiRequest<GenerationJob>(`/generation-jobs/${enc(jobId ?? "")}`),
    enabled: jobId !== null,
  });
  const manifestId = job.data?.manifest_id ?? null;
  const manifest = useQuery({
    queryKey: queryKeys.manifest(manifestId ?? ""),
    queryFn: () => apiRequest<GenerationManifest>(`/generation-manifests/${enc(manifestId ?? "")}`),
    enabled: manifestId !== null,
  });
  return { job, manifest };
}

export function useUpdateMemo() {
  const invalidate = useInvalidateArtifacts();
  return useMutation({
    mutationFn: ({ artifactId, memo }: { artifactId: string; memo: string }) =>
      apiRequest<ArtifactRecord>(`/artifacts/${enc(artifactId)}`, { method: "PATCH", body: JSON.stringify({ memo }) }),
    onSettled: (_data, _error, { artifactId }) => invalidate([artifactId]),
  });
}

export function useSetDecision() {
  const invalidate = useInvalidateArtifacts();
  return useMutation({
    mutationFn: ({ artifactId, decision }: { artifactId: string; decision: ArtifactDecision }) =>
      apiRequest<ArtifactRecord>(`/artifacts/${enc(artifactId)}/decision`, {
        method: "PATCH",
        body: JSON.stringify({ decision }),
      }),
    onSettled: (_data, _error, { artifactId }) => invalidate([artifactId]),
  });
}

/** 紐づけたシーンのシーン画像に採用する。採否は`accepted`になり、前の採用は外れる。 */
export function useAdoptSceneImage() {
  const client = useQueryClient();
  const invalidate = useInvalidateArtifacts();
  return useMutation({
    mutationFn: ({ projectId, sceneId, artifactId }: { projectId: string; sceneId: string; artifactId: string }) =>
      apiRequest<StorySceneAdoption>(
        `/projects/${enc(projectId)}/story-scenes/${enc(sceneId)}/adoptions/scene_image`,
        { method: "PUT", body: JSON.stringify({ artifact_id: artifactId }) },
      ),
    onSettled: (_data, _error, { projectId, sceneId, artifactId }) =>
      Promise.all([
        invalidate([artifactId]),
        // 外れた前の生成物の採否も戻るので、詳細は1件に絞らずまとめて取り直す。
        client.invalidateQueries({ queryKey: queryKeys.artifacts }),
        client.invalidateQueries({ queryKey: queryKeys.sceneAdoptions(projectId, sceneId) }),
      ]),
  });
}

// ---- 一括操作 ----

/** 200件ずつ順に送る。途中で失敗したら、送り終えた分を`PartialFailureError`に含める。 */
async function batchOperation(ids: string[], operation: BatchOperation, projectId: string | null = null) {
  const doneIds: string[] = [];
  for (const part of chunks(ids)) {
    try {
      await apiRequest<ArtifactRecord[]>("/artifacts/batch-operation", {
        method: "POST",
        body: JSON.stringify({
          artifact_ids: part,
          operation,
          target: operation === "move" ? { project_id: projectId } : null,
        }),
      });
    } catch (error) {
      throw new PartialFailureError(error, doneIds, ids.slice(doneIds.length));
    }
    doneIds.push(...part);
  }
}

/** ゴミ箱へ移す・復元する。200件を超えたら分けて送る。 */
export function useBatchOperation() {
  const invalidate = useInvalidateArtifacts();
  return useMutation({
    mutationFn: ({ ids, operation }: { ids: string[]; operation: "trash" | "restore" }) => batchOperation(ids, operation),
    onSettled: (_data, _error, { ids }) => invalidate(ids),
  });
}

/**
 * 紐づけを付け替える。Projectが変わる生成物だけ先にProjectを移し (`move`/`unassign`)、
 * そのあとキャラ・衣装・シーンを1件ずつ更新する。APIは紐づけ先を生成物のProjectで検証するため、この順にする。
 * 途中で失敗するとProjectだけ移った生成物が残るが、同じ紐づけで再実行すれば揃う。
 */
export function useApplyLinks() {
  const invalidate = useInvalidateArtifacts();
  return useMutation({
    mutationFn: async ({ items, links }: { items: SelectedArtifact[]; links: StoryLinks }) => {
      const moving = items.filter((item) => item.projectId !== links.project).map((item) => item.id);
      if (moving.length > 0) {
        try {
          await batchOperation(moving, links.project ? "move" : "unassign", links.project);
        } catch (error) {
          // Projectの移動で止まったときは、キャラ・衣装・シーンはどれも変えていない。
          throw new PartialFailureError(
            error,
            [],
            items.map((item) => item.id),
          );
        }
      }
      const body = JSON.stringify({
        story_scene_id: links.scene,
        story_character_id: links.character,
        story_costume_id: links.outfit,
      });
      await runLimited(
        items.map((item) => item.id),
        PATCH_CONCURRENCY,
        (id) => apiRequest<ArtifactRecord>(`/artifacts/${enc(id)}`, { method: "PATCH", body }),
      );
    },
    onSettled: (_data, _error, { items }) => invalidate(items.map((item) => item.id)),
  });
}

// ---- 完全削除 ----

/** 完全削除の影響。200件ずつ確かめて合算する。 */
export type PurgeSummary = {
  count: number;
  removedByteSize: number;
  removedFileCount: number;
  sharedFileCount: number;
  detachedChildCount: number;
  notTrashedIds: string[];
};

async function previewPurge(ids: string[]): Promise<PurgeSummary> {
  const summary: PurgeSummary = {
    count: 0,
    removedByteSize: 0,
    removedFileCount: 0,
    sharedFileCount: 0,
    detachedChildCount: 0,
    notTrashedIds: [],
  };
  for (const part of chunks(ids)) {
    const preview = await apiRequest<ArtifactPurgePreview>("/artifacts/purge-preview", {
      method: "POST",
      body: JSON.stringify({ artifact_ids: part }),
    });
    summary.count += preview.artifacts.length;
    summary.removedByteSize += preview.removed_byte_size;
    summary.removedFileCount += preview.removed_file_count;
    summary.sharedFileCount += preview.shared_file_count;
    summary.detachedChildCount += preview.detached_child_count;
    summary.notTrashedIds.push(...preview.not_trashed_ids);
  }
  return summary;
}

export function usePurgePreview(ids: string[], enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.artifactPurgePreview(ids),
    queryFn: () => previewPurge(ids),
    enabled: enabled && ids.length > 0,
    gcTime: 0,
  });
}

export function usePurge() {
  const invalidate = useInvalidateArtifacts();
  return useMutation({
    mutationFn: async (ids: string[]) => {
      let removedByteSize = 0;
      let sent = 0;
      const purgedIds: string[] = [];
      for (const part of chunks(ids)) {
        let result: ArtifactPurgeResult;
        try {
          result = await apiRequest<ArtifactPurgeResult>("/artifacts/purge", {
            method: "POST",
            body: JSON.stringify({ artifact_ids: part, confirm: true }),
          });
        } catch (error) {
          throw new PartialFailureError(error, purgedIds, ids.slice(sent));
        }
        sent += part.length;
        removedByteSize += result.removed_byte_size;
        purgedIds.push(...result.purged_ids);
      }
      return { removedByteSize, purged: purgedIds.length };
    },
    onSettled: () => invalidate(),
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
