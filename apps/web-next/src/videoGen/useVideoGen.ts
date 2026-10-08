import { useLocalStorage } from "@mantine/hooks";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";

import { apiRequest, type ArtifactRecord, type Recipe } from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { isRecord, normalizeTarget, type ImageTarget } from "../imageGen/imageForm";
import {
  defaultDraft,
  normalizeDraft,
  VIDEO_TEMPLATES,
  type VideoDraft,
  type VideoMode,
  type VideoRecipes,
} from "./videoForm";

const enc = encodeURIComponent;

// ---- 入力欄と結果欄の保存 ----

/** 入力欄の内容と対象。最後に使った値をブラウザに残し、画面を離れて戻っても続きから書ける。 */
export type StoredVideoInput = { draft: VideoDraft; target: ImageTarget | null };

/** 結果欄に出すJob。 */
export type VideoResultEntry = { jobId: string };

/** 結果欄に残すJobの数。古いものから落とす。 */
const RESULTS_MAX = 30;

/** localStorageの文字列をJSONとして読む。読めなければ`undefined`。 */
function parseStored(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function useStoredVideoInput(recipes: VideoRecipes) {
  return useLocalStorage<StoredVideoInput>({
    key: "web-next:video-input",
    defaultValue: { draft: defaultDraft(recipes), target: null },
    // 初回の描画から保存済みの値を使う。既定値で描いてから差し替えると、対象の復元が既定値で上書きされる。
    getInitialValueInEffect: false,
    deserialize: (value) => {
      const raw = parseStored(value);
      const base = defaultDraft(recipes);
      if (!isRecord(raw)) return { draft: base, target: null };
      return {
        draft: isRecord(raw.draft) ? normalizeDraft(raw.draft, base) : base,
        target: normalizeTarget(raw.target),
      };
    },
  });
}

export function useVideoResultEntries() {
  const [entries, setEntries] = useLocalStorage<VideoResultEntry[]>({
    key: "web-next:video-results",
    defaultValue: [],
    getInitialValueInEffect: false,
    deserialize: (value) => {
      const raw = parseStored(value);
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((item): item is VideoResultEntry => isRecord(item) && typeof item.jobId === "string")
        .slice(0, RESULTS_MAX);
    },
  });
  const add = useCallback(
    (entry: VideoResultEntry) =>
      setEntries((list) => [entry, ...list.filter((item) => item.jobId !== entry.jobId)].slice(0, RESULTS_MAX)),
    [setEntries],
  );
  const remove = useCallback(
    (jobId: string) => setEntries((list) => list.filter((item) => item.jobId !== jobId)),
    [setEntries],
  );
  return { entries, add, remove };
}

// ---- Recipe ----

/** 動画のRecipe。方式のテンプレートごとに、最新の版の先頭を使う。 */
export function useVideoRecipes() {
  return useQuery({
    queryKey: queryKeys.recipes("video"),
    queryFn: () => apiRequest<Recipe[]>("/recipes?kind=video"),
    select: (recipes): VideoRecipes => {
      const find = (mode: VideoMode) =>
        recipes.find((recipe) => recipe.workflow_template_ref.name === VIDEO_TEMPLATES[mode]) ?? null;
      return { i2v: find("i2v"), ref2v: find("ref2v") };
    },
  });
}

// ---- 結果 ----

/** Jobの動画の生成物。ゴミ箱のものは除く。 */
export function useJobVideos(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jobVideos(jobId),
    queryFn: () => apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(jobId)}/artifacts`),
    select: (items) => items.filter((item) => item.kind === "video" && item.deleted_at === null),
    enabled,
  });
}
