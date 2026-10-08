import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiRequest, type ProjectList, type ProjectPurgeResult, type ProjectRecord } from "../api/client";
import { queryKeys } from "../api/queryKeys";

export type ProjectTab = "active" | "trashed";

export type ProjectDraft = {
  name: string;
  description: string | null;
};

/** `GET /projects`の`limit`の上限。 */
const PAGE_LIMIT = 200;

/**
 * APIの`sort=updated`はお気に入りを先頭に寄せるため、1ページで切ると更新が新しいProjectが漏れる。
 * 全ページを取ってから更新日時の降順に並べ直す。
 */
async function fetchAllProjects(lifecycle: ProjectTab): Promise<ProjectRecord[]> {
  const items: ProjectRecord[] = [];
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    const params = new URLSearchParams({
      lifecycle,
      sort: "updated",
      limit: String(PAGE_LIMIT),
      offset: String(offset),
    });
    const page = await apiRequest<ProjectList>(`/projects?${params}`);
    items.push(...page.items);
    if (page.items.length < PAGE_LIMIT) return items;
  }
}

export function useProjectList(tab: ProjectTab) {
  return useQuery({
    queryKey: queryKeys.projectList(tab),
    queryFn: () => fetchAllProjects(tab),
    select: (items) => [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
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
    // 取り消せない操作なので、画面の確認ダイアログを経てから呼ぶ。
    mutationFn: (id: string) =>
      apiRequest<ProjectPurgeResult>(`/projects/${encodeURIComponent(id)}/permanent?confirm=true`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  });
}
