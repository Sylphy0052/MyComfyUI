import { useLocalStorage } from "@mantine/hooks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import { isRecord } from "../imageGen/imageForm";
import { secondStepOrUndo, type SceneDecision } from "../imageGen/useImageGen";
import {
  BGM_TEMPLATE,
  defaultBgmForm,
  normalizeBgmForm,
  normalizeBgmTarget,
  videoSecondsOf,
  type StoredBgmInput,
} from "./bgmForm";

const enc = encodeURIComponent;

// ---- 入力欄と結果欄の保存 ----

/** 結果欄に出すJob。1本のJobから1曲できるため、枚数は持たない。 */
export type BgmResultEntry = { jobId: string };

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

/** 最後に使った入力欄と対象をブラウザに残し、画面を離れて戻っても続きから書けるようにする。 */
export function useStoredBgmInput(recipe: Recipe) {
  return useLocalStorage<StoredBgmInput>({
    key: "web-next:bgm-input",
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

export function useBgmResultEntries() {
  const [entries, setEntries] = useLocalStorage<BgmResultEntry[]>({
    key: "web-next:bgm-results",
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
    queryFn: async (): Promise<number | null> => {
      const adoptions = await apiRequest<StorySceneAdoption[]>(
        `/projects/${enc(projectId ?? "")}/story-scenes/${enc(sceneId ?? "")}/adoptions`,
      );
      const video = adoptions.find((item) => item.slot === "video");
      if (!video) return null;
      const artifact = await apiRequest<ArtifactRecord>(`/artifacts/${enc(video.artifact_id)}`);
      if (artifact.job_id === null) return null;
      const job = await apiRequest<GenerationJob>(`/generation-jobs/${enc(artifact.job_id)}`);
      const manifest = await apiRequest<GenerationManifest>(`/generation-manifests/${enc(job.manifest_id)}`);
      return videoSecondsOf(manifest);
    },
  });
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
    queryKey: [...queryKeys.job(jobId), "audio"],
    queryFn: () => apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(jobId)}/artifacts`),
    select: (items) => items.filter((item) => item.kind === "audio" && item.deleted_at === null),
    enabled,
  });
}

// ---- 結果のカードの操作 ----

export function useSaveBgmMemo(jobId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ artifactId, memo }: { artifactId: string; memo: string }) =>
      apiRequest<ArtifactRecord>(`/artifacts/${enc(artifactId)}`, {
        method: "PATCH",
        body: JSON.stringify({ memo }),
      }),
    onSuccess: (saved) => {
      client.setQueryData<ArtifactRecord[]>([...queryKeys.job(jobId), "audio"], (list) =>
        list?.map((item) => (item.id === saved.id ? saved : item)),
      );
      client.setQueryData(queryKeys.artifact(saved.id), saved);
    },
  });
}

/**
 * SceneのBGM枠への採用と、不採用の印。枠は1件だけなので、採用すると前のBGMは枠から外れる。
 * 不採用の生成物は採用できないため、採用の前に採否を戻す。採用中のものを不採用にするときは先に枠から外す。
 */
export function useBgmDecision(projectId: string, sceneId: string) {
  const client = useQueryClient();
  const slotPath = `/projects/${enc(projectId)}/story-scenes/${enc(sceneId)}/adoptions/bgm`;
  const setDecision = (artifactId: string, decision: ArtifactRecord["decision"]) =>
    apiRequest<ArtifactRecord>(`/artifacts/${enc(artifactId)}/decision`, {
      method: "PATCH",
      body: JSON.stringify({ decision }),
    });
  const adopt = (artifactId: string) =>
    apiRequest(slotPath, { method: "PUT", body: JSON.stringify({ artifact_id: artifactId }) });
  return useMutation({
    mutationFn: async ({
      artifact,
      action,
      adopted,
    }: {
      artifact: ArtifactRecord;
      action: SceneDecision;
      /** 今この生成物がBGM枠に採用されているか。 */
      adopted: boolean;
    }) => {
      if (action === "adopt") {
        if (artifact.decision !== "rejected") {
          await adopt(artifact.id);
          return;
        }
        await setDecision(artifact.id, "undecided");
        await secondStepOrUndo(
          () => adopt(artifact.id),
          () => setDecision(artifact.id, "rejected"),
          "不採用の印だけが外れています",
        );
        return;
      }
      if (action === "release") {
        await apiRequest(slotPath, { method: "DELETE" });
        return;
      }
      if (action === "reject" && adopted) {
        await apiRequest(slotPath, { method: "DELETE" });
        await secondStepOrUndo(
          () => setDecision(artifact.id, "rejected"),
          () => adopt(artifact.id),
          "採用だけが外れています",
        );
        return;
      }
      await setDecision(artifact.id, action === "reject" ? "rejected" : "undecided");
    },
    // 採用を差し替えると前の生成物の採否も変わるため、結果欄の生成物はまとめて取り直す。
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.sceneAdoptions(projectId, sceneId) }),
        client.invalidateQueries({ queryKey: queryKeys.jobs }),
      ]),
  });
}
