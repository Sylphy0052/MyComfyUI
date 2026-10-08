import { useQuery } from "@tanstack/react-query";
import { useMatch, useSearchParams } from "react-router";

import { apiRequest, type ProjectList, type ProjectRecord } from "../api/client";
import { queryKeys } from "../api/queryKeys";

/**
 * 現在のProject。`/projects/:id`ならパスから、それ以外は`?project=`から取る。
 * 対象はURLにだけ持たせ、全体の状態としては持たない。
 */
export function useCurrentProjectId(): string | null {
  const match = useMatch("/projects/:projectId/*");
  const [searchParams] = useSearchParams();
  return match?.params.projectId ?? searchParams.get("project");
}

/** 画面の移動先へ現在のProjectを引き継ぐ`search`。 */
export function projectSearch(projectId: string | null): string {
  return projectId ? `?${new URLSearchParams({ project: projectId })}` : "";
}

export function useProject(projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.project(projectId ?? ""),
    queryFn: () => apiRequest<ProjectRecord>(`/projects/${encodeURIComponent(projectId ?? "")}`),
    enabled: projectId !== null,
  });
}

/** Jobの行にProject名を出すための対応表。ゴミ箱のProjectは含まないので、名前が無ければIDを出す。 */
export function useProjectNames() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: () => apiRequest<ProjectList>("/projects"),
    select: (list) => new Map(list.items.map((project) => [project.id, project.name])),
  });
}
