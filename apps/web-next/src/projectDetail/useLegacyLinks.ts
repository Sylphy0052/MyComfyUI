import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { apiRequest } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import type { components } from "../api/schema";

export type LegacyLinkResult = components["schemas"]["LegacyLinkResult"];

const enc = encodeURIComponent;

// Project配下に置くので、`queryKeys.project(id)`の無効化でも取り直される。
const previewKey = (projectId: string) => [...queryKeys.project(projectId), "legacy-links", "preview"] as const;

/** 付け替える件数と、付けない件数 (理由ごと)。DBは変えない。 */
export function useLegacyLinkPreview(projectId: string) {
  return useQuery({
    queryKey: previewKey(projectId),
    queryFn: () => apiRequest<LegacyLinkResult>(`/projects/${enc(projectId)}/legacy-links/preview`, { method: "POST" }),
  });
}

/** 旧生成物の`story_scene_id`を埋める。付いた生成物は、Viewerとシーン生成画面の候補に出る。 */
export function useRunLegacyLinks(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest<LegacyLinkResult>(`/projects/${enc(projectId)}/legacy-links`, { method: "POST" }),
    // 失敗しても一部が付いているかもしれないので、成否によらず取り直す。
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
        client.invalidateQueries({ queryKey: queryKeys.artifacts }),
        client.invalidateQueries({ queryKey: queryKeys.artifactLists }),
        client.invalidateQueries({ queryKey: queryKeys.mediaItems }),
        client.invalidateQueries({ queryKey: queryKeys.jobs }),
      ]),
  });
}
