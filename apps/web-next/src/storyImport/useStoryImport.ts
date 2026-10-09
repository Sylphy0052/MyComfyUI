import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import {
  ApiError,
  apiRequest,
  type ExternalProjectCandidateList,
  type ProjectLocalOverrides,
  type ProjectRecord,
  type StoryImportResult,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";

const projectPath = (projectId: string) => `/projects/${encodeURIComponent(projectId)}`;

// 実行中はモーダルを閉じられないので、応答が返らないまま固まらないよう、DBを変える要求は時間で打ち切る。
const IMPORT_TIMEOUT_MS = 5 * 60_000;

async function importRequest<T>(path: string, init: RequestInit): Promise<T> {
  const signal = AbortSignal.timeout(IMPORT_TIMEOUT_MS);
  try {
    return await apiRequest<T>(path, { ...init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new ApiError(0, "応答が5分間無かったため打ち切りました。取り込まれたかはProject詳細で確かめてください。");
    }
    throw error;
  }
}

/** mutationの実行中を親へ知らせる。アンマウント時は実行中でなくなったことを知らせる。 */
export function useReportPending(pending: boolean, onPendingChange: (pending: boolean) => void) {
  useEffect(() => {
    onPendingChange(pending);
    return () => onPendingChange(false);
  }, [pending, onPendingChange]);
}

/** novel-writerの候補一覧。モーダルを開いている間だけ取り、開くたびに取り直す。 */
export function useExternalCandidates(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.externalCandidates,
    queryFn: () => apiRequest<ExternalProjectCandidateList>("/projects/external-candidates"),
    enabled,
    // 取り込み元の設定違いは再試行しても直らない。エラーはすぐモーダルに出す。
    retry: false,
    gcTime: 0,
  });
}

/** 旧キャラ設定の有無を見るために読む。外部Projectは常にsnapshotを持つので読まない。 */
export function useLocalOverrides(projectId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.projectLocalOverrides(projectId),
    queryFn: () => apiRequest<ProjectLocalOverrides>(`${projectPath(projectId)}/local-overrides`),
    enabled,
  });
}

/** 候補からProjectを作る。取り込み済みの候補には呼ばない (`imported_project_id`を使う)。 */
export function useImportExternalProject() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (externalId: string) =>
      importRequest<ProjectRecord>("/projects/import", {
        method: "POST",
        body: JSON.stringify({ external_id: externalId }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projects }),
  });
}

/** 作る件数のプレビュー。DBは変わらないので、結果は取り込み前の確認にだけ使う。 */
export function useStoryImportPreview() {
  return useMutation({
    mutationFn: (projectId: string) =>
      apiRequest<StoryImportResult>(`${projectPath(projectId)}/story-import/preview`, { method: "POST" }),
  });
}

/** 取り込みを実行し、キャラ一覧とシーン一覧 (と衣装) を取り直す。 */
export function useRunStoryImport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      importRequest<StoryImportResult>(`${projectPath(projectId)}/story-import`, { method: "POST" }),
    onSuccess: (_result, projectId) => client.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });
}
