import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiRequest, type ProjectList, type ProjectPurgeResult, type ProjectRecord } from "../api/client";
import { queryKeys } from "../api/queryKeys";

export type ProjectTab = "active" | "trashed";

export type ProjectDraft = {
  name: string;
  description: string | null;
};

/** `GET /projects`の`limit`の上限。 */
const LIST_LIMIT = 200;

/**
 * 一覧は更新日時の降順に並べる。APIの`sort=updated`はお気に入りを先頭に寄せるため、ここで並べ直す。
 */
export function useProjectList(tab: ProjectTab) {
  return useQuery({
    queryKey: queryKeys.projectList(tab),
    queryFn: () =>
      apiRequest<ProjectList>(
        `/projects?${new URLSearchParams({ lifecycle: tab, sort: "updated", limit: String(LIST_LIMIT) })}`,
      ),
    select: (list) => ({
      items: [...list.items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      truncated: list.items.length >= LIST_LIMIT,
    }),
  });
}

/** Projectの変更は一覧・ヘッダーの名前・詳細のどれにも効くので、`projects`の系統をまとめて取り直す。 */
function useInvalidateProjects() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.projects });
}

export function useCreateProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (draft: ProjectDraft) =>
      apiRequest<ProjectRecord>("/projects", { method: "POST", body: JSON.stringify(draft) }),
    onSuccess: invalidate,
  });
}

export function useUpdateProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: ProjectDraft }) =>
      apiRequest<ProjectRecord>(`/projects/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(draft),
      }),
    onSuccess: invalidate,
  });
}

export function useTrashProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    // ゴミ箱へ移すのは復元できる操作なので、関連データがあるときの確認 (`confirm`) は画面で求めない。
    mutationFn: (id: string) =>
      apiRequest<ProjectRecord>(`/projects/${encodeURIComponent(id)}?confirm=true`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
}

export function useRestoreProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<ProjectRecord>(`/projects/${encodeURIComponent(id)}/restore`, { method: "POST" }),
    onSuccess: invalidate,
  });
}

export function usePurgeProject() {
  const invalidate = useInvalidateProjects();
  return useMutation({
    mutationFn: (id: string) =>
      apiRequest<ProjectPurgeResult>(`/projects/${encodeURIComponent(id)}/permanent?confirm=true`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });
}
