import { useLocalStorage } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import {
  apiRequest,
  type ArtifactRecord,
  type GenerationJob,
  type GenerationJobBody,
  type GenerationManifest,
  type Recipe,
  type StorySceneAdoption,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { fetchJobSettings } from "../imageGen/artifactRestore";
import { isRecord } from "../imageGen/imageForm";
import { useSlotDecision } from "../imageGen/useImageGen";
import {
  BGM_TEMPLATE,
  bgmRestoredFromManifest,
  defaultBgmForm,
  normalizeBgmForm,
  normalizeBgmTarget,
  videoSecondsOf,
  type BgmRestored,
  type StoredBgmInput,
} from "./bgmForm";

const enc = encodeURIComponent;

// ---- 入力欄と結果欄の保存 ----

/** 結果欄に出すJob。1本のJobから1曲できるため、枚数は持たない。 */
export type BgmResultEntry = { jobId: string };

/** 結果欄に残すJobの数。古いものから落とす。 */
export const RESULTS_MAX = 30;

/** localStorageの文字列をJSONとして読む。読めなければ`undefined`。 */
function parseStored(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** localStorageのキー。入力欄と結果欄で分ける。シーン生成の工程は`/bgm`と別のキーを渡す。 */
export type BgmStorageKeys = { input: string; results: string };

/** `/bgm`の保存キー。 */
export const BGM_STORAGE_KEYS: BgmStorageKeys = {
  input: "web-next:bgm-input",
  results: "web-next:bgm-results",
};

/** 最後に使った入力欄と対象をブラウザに残し、画面を離れて戻っても続きから書けるようにする。 */
export function useStoredBgmInput(recipe: Recipe, key: string) {
  return useLocalStorage<StoredBgmInput>({
    key,
    defaultValue: { form: null, target: null },
    // 初回の描画から保存済みの値を使う。既定値で描いてから差し替えると、対象の復元が既定値で上書きされる。
    getInitialValueInEffect: false,
    // 壊れた値・`null`・古い形の値でも画面が開けるよう、型の合う値だけを読む。
    deserialize: (value) => {
      const raw = parseStored(value);
      if (!isRecord(raw)) return { form: null, target: null };
      return {
        form: isRecord(raw.form) ? normalizeBgmForm(raw.form, defaultBgmForm(recipe)) : null,
        target: normalizeBgmTarget(raw.target),
      };
    },
  });
}

export function useBgmResultEntries(key: string) {
  const [entries, setEntries] = useLocalStorage<BgmResultEntry[]>({
    key,
    defaultValue: [],
    getInitialValueInEffect: false,
    deserialize: (value) => {
      const raw = parseStored(value);
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((item): item is BgmResultEntry => isRecord(item) && typeof item.jobId === "string")
        .map((item) => ({ jobId: item.jobId }))
        .slice(0, RESULTS_MAX);
    },
  });
  const add = useCallback(
    (entry: BgmResultEntry) =>
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

/** BGM生成のRecipe。`ace_step_bgm`のうち最新の版の先頭を使う。 */
export function useBgmRecipe() {
  return useQuery({
    queryKey: queryKeys.recipes("music"),
    queryFn: () => apiRequest<Recipe[]>("/recipes?kind=music"),
    select: (recipes) => recipes.find((recipe) => recipe.workflow_template_ref.name === BGM_TEMPLATE) ?? null,
  });
}

// ---- 長さの既定値 ----

/**
 * Sceneに採用済みの動画の長さ (秒)。採用枠`video`の生成物 → そのJob → Manifestの`length / fps`で計算する。
 * 採用済みの動画が無い、Jobを持たない動画、Manifestから読めない場合は`null`。
 * 採用の変更で取り直されるよう、採用枠のqueryKeyの下に置く。
 */
export function useAdoptedVideoSeconds(projectId: string | null, sceneId: string | null) {
  return useQuery({
    queryKey: [...queryKeys.sceneAdoptions(projectId ?? "", sceneId ?? ""), "video-seconds"],
    enabled: projectId !== null && sceneId !== null,
    queryFn: () => fetchAdoptedVideoSeconds(projectId ?? "", sceneId ?? ""),
  });
}

/** `useAdoptedVideoSeconds`の取得。画面を介さず長さの既定値を求めるときに使う。 */
export async function fetchAdoptedVideoSeconds(projectId: string, sceneId: string): Promise<number | null> {
  const adoptions = await apiRequest<StorySceneAdoption[]>(
    `/projects/${enc(projectId)}/story-scenes/${enc(sceneId)}/adoptions`,
  );
  const video = adoptions.find((item) => item.slot === "video");
  if (!video) return null;
  const artifact = await apiRequest<ArtifactRecord>(`/artifacts/${enc(video.artifact_id)}`);
  if (artifact.job_id === null) return null;
  const job = await apiRequest<GenerationJob>(`/generation-jobs/${enc(artifact.job_id)}`);
  const manifest = await apiRequest<GenerationManifest>(`/generation-manifests/${enc(job.manifest_id)}`);
  return videoSecondsOf(manifest);
}

// ---- 投入と結果 ----

/**
 * 枚数ぶんのJobを順に投入する。途中で失敗したら、そこで止めて何本入ったかをエラーに添える。
 * 投入できたJobは1本ごとに`onSubmitted`へ渡す。
 */
export function useSubmitBgmJobs() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      bodies,
      onSubmitted,
    }: {
      bodies: GenerationJobBody[];
      onSubmitted: (job: GenerationJob) => void;
    }) => {
      let submitted = 0;
      try {
        for (const body of bodies) {
          const job = await apiRequest<GenerationJob>("/generation-jobs", {
            method: "POST",
            body: JSON.stringify(body),
          });
          client.setQueryData(queryKeys.job(job.id), job);
          onSubmitted(job);
          submitted += 1;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          bodies.length > 1 ? `${bodies.length}本中${submitted}本を投入して止まりました: ${reason}` : reason,
        );
      }
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.jobs }),
  });
}

/** Jobの音声の生成物。ゴミ箱のものは除く。Jobの状態が変わるイベントで取り直される。 */
export function useJobAudio(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jobAudio(jobId),
    queryFn: () => apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(jobId)}/artifacts`),
    select: (items) => items.filter((item) => item.kind === "audio" && item.deleted_at === null),
    enabled,
  });
}

// ---- 結果のカードの操作 ----

/**
 * SceneのBGM枠への採用と、不採用の印。枠は1件だけなので、採用すると前のBGMは枠から外れる。
 * 手順は`useSlotDecision`と同じ。
 */
export function useBgmDecision(projectId: string, sceneId: string) {
  return useSlotDecision(projectId, sceneId, "bgm");
}

// ---- 生成物からの復元 ----

/** `/bgm?from_artifact=`で開いたとき、生成物を作った音楽Jobの設定を入力欄の内容にする。 */
export async function restoreBgmFromJob(client: QueryClient, jobId: string, recipe: Recipe): Promise<BgmRestored> {
  const { job, manifest } = await fetchJobSettings(client, jobId, "music", "音楽");
  return bgmRestoredFromManifest(defaultBgmForm(recipe), job, manifest);
}
