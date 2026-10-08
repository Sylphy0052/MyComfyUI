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
  type StoryCharacter,
  type StoryCostume,
  type StoryScene,
  type WorkflowModelOptions,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";
import { ACTIVE_STATES } from "../jobs/useJobs";
import { useCharacters, useScenes } from "../projectDetail/useStory";
import {
  BATCH_MAX,
  defaultForm,
  formFromManifest,
  isRecord,
  normalizeForm,
  normalizeTarget,
  TXT2IMG_TEMPLATE,
  type ImageForm,
  type ImageTarget,
} from "./imageForm";
import { buildSupplementTags, partitionPrompt } from "./promptTags";

const enc = encodeURIComponent;

// ---- 入力欄と結果欄の保存 ----

/** 入力欄の内容と対象。最後に使った値をブラウザに残し、画面を離れて戻っても続きから書ける。 */
export type StoredInput = { form: ImageForm | null; target: ImageTarget | null };

/** 結果欄に出すJob。枚数はプレースホルダの数に使う。 */
export type ResultEntry = { jobId: string; count: number };

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

/** 保存してあった結果欄。Jobのidと1..`BATCH_MAX`の枚数を持つ要素だけを残す。 */
function normalizeEntries(raw: unknown): ResultEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is ResultEntry =>
        isRecord(item) &&
        typeof item.jobId === "string" &&
        typeof item.count === "number" &&
        Number.isInteger(item.count) &&
        item.count >= 1 &&
        item.count <= BATCH_MAX,
    )
    .slice(0, RESULTS_MAX);
}

export function useStoredInput(recipe: Recipe) {
  return useLocalStorage<StoredInput>({
    key: "web-next:image-input",
    defaultValue: { form: null, target: null },
    // 初回の描画から保存済みの値を使う。既定値で描いてから差し替えると、対象の復元が既定値で上書きされる。
    getInitialValueInEffect: false,
    // 壊れた値・`null`・古い形の値でも画面が開けるよう、型の合う値だけを読む。
    deserialize: (value) => {
      const raw = parseStored(value);
      if (!isRecord(raw)) return { form: null, target: null };
      return {
        form: isRecord(raw.form) ? normalizeForm(raw.form, defaultForm(recipe)) : null,
        target: normalizeTarget(raw.target),
      };
    },
  });
}

export function useResultEntries() {
  const [entries, setEntries] = useLocalStorage<ResultEntry[]>({
    key: "web-next:image-results",
    defaultValue: [],
    getInitialValueInEffect: false,
    deserialize: (value) => normalizeEntries(parseStored(value)),
  });
  const add = useCallback(
    (entry: ResultEntry) =>
      setEntries((list) => [entry, ...list.filter((item) => item.jobId !== entry.jobId)].slice(0, RESULTS_MAX)),
    [setEntries],
  );
  const remove = useCallback(
    (jobId: string) => setEntries((list) => list.filter((item) => item.jobId !== jobId)),
    [setEntries],
  );
  return { entries, add, remove };
}

// ---- Recipeとモデル ----

/** 新規生成のRecipe。`anima_txt2img`のうち最新の版の先頭を使う。 */
export function useTxt2ImgRecipe() {
  return useQuery({
    queryKey: queryKeys.recipes("image"),
    queryFn: () => apiRequest<Recipe[]>("/recipes?kind=image"),
    select: (recipes) => recipes.find((recipe) => recipe.workflow_template_ref.name === TXT2IMG_TEMPLATE) ?? null,
  });
}

/** ComfyUIにあるモデルの候補。ComfyUIに届かないときは候補が空で返る。 */
export function useModelOptions(workflowVersionId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.modelOptions(workflowVersionId ?? ""),
    queryFn: () => apiRequest<WorkflowModelOptions>(`/workflow-versions/${enc(workflowVersionId ?? "")}/models`),
    enabled: enabled && workflowVersionId !== null,
    staleTime: 60_000,
  });
}

// ---- 対象 ----

/**
 * 補完タグの元になるキャラ・衣装・シーン。Projectを指定していなければ取らない。
 * Project画面と同じhook (`useCharacters`・`useScenes`) を使い、キャッシュを共有する。
 */
export function useProjectStory(projectId: string | null) {
  const characters = useCharacters(projectId);
  const scenes = useScenes(projectId);
  return {
    characters: characters.data ?? [],
    scenes: scenes.data ?? [],
    isLoading: projectId !== null && (characters.isPending || scenes.isPending),
    error: projectId === null ? null : (characters.error ?? scenes.error),
  };
}

// ---- 投入と結果 ----

export function useSubmitImageJob() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: GenerationJobBody) =>
      apiRequest<GenerationJob>("/generation-jobs", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (job) => {
      client.setQueryData(queryKeys.job(job.id), job);
      return client.invalidateQueries({ queryKey: queryKeys.jobs });
    },
  });
}

function isActive(job: GenerationJob | undefined): boolean {
  return job !== undefined && (ACTIVE_STATES as readonly string[]).includes(job.state);
}

/** 待機中・実行中のJobを取り直す間隔。完了はWebSocketのイベントでも知るが、切れていても結果欄が進むようにする。 */
const ACTIVE_POLL_MS = 5_000;

export function useJob(jobId: string) {
  return useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => apiRequest<GenerationJob>(`/generation-jobs/${enc(jobId)}`),
    // 取り直しに失敗している間は止める (404やAPI停止で回り続けないように)。イベントで取り直せたら再開する。
    refetchInterval: (query) =>
      query.state.status !== "error" && query.state.fetchFailureCount === 0 && isActive(query.state.data)
        ? ACTIVE_POLL_MS
        : false,
  });
}

/** Jobの画像の生成物。Workflowのスナップショットとゴミ箱のものは除く。 */
export function useJobImages(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jobImages(jobId),
    queryFn: () => apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(jobId)}/artifacts`),
    select: (items) => items.filter((item) => item.kind === "image" && item.deleted_at === null),
    enabled,
  });
}

// ---- 結果のカードの操作 ----

/** 生成物の応答を、そのJobの生成物一覧へ反映する。 */
function putArtifact(client: QueryClient, saved: ArtifactRecord): void {
  if (saved.job_id === null) return;
  client.setQueryData<ArtifactRecord[]>(queryKeys.jobImages(saved.job_id), (list) =>
    list?.map((item) => (item.id === saved.id ? saved : item)),
  );
  client.setQueryData(queryKeys.artifact(saved.id), saved);
}

export function useSaveArtifactMemo() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ artifactId, memo }: { artifactId: string; memo: string }) =>
      apiRequest<ArtifactRecord>(`/artifacts/${enc(artifactId)}`, {
        method: "PATCH",
        body: JSON.stringify({ memo }),
      }),
    onSuccess: (saved) => putArtifact(client, saved),
  });
}

export type SceneDecision = "adopt" | "release" | "reject" | "unreject";

/** 2段に分かれた変更の2段目。失敗したら1段目を戻し、戻せなければどこまで反映されたかをエラーに書き足す。 */
async function secondStepOrUndo(
  run: () => Promise<unknown>,
  undo: () => Promise<unknown>,
  leftState: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    try {
      await undo();
    } catch {
      throw new Error(`${error instanceof Error ? error.message : String(error)} (元に戻せず、${leftState})`);
    }
    throw error;
  }
}

/**
 * Sceneのシーン画像枠への採用と、不採用の印。
 * 不採用の生成物は採用できないため、採用の前に採否を戻す。採用中のものを不採用にするときは先に枠から外す。
 */
export function useSceneDecision(projectId: string, sceneId: string) {
  const client = useQueryClient();
  const slotPath = `/projects/${enc(projectId)}/story-scenes/${enc(sceneId)}/adoptions/scene_image`;
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
      /** 今この生成物がシーン画像枠に採用されているか。 */
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

/** 生成物を衣装の参照画像の末尾へ足す。 */
export function useAddCostumeReference(projectId: string) {
  const client = useQueryClient();
  const key = queryKeys.projectCharacters(projectId);
  return useMutation({
    mutationFn: async ({ costume, artifactId }: { costume: StoryCostume; artifactId: string }) => {
      // 別のタブやProject画面での追加・削除を上書きしないよう、送る直前に最新の参照画像を取り直す。
      const characters = await client.fetchQuery({
        queryKey: key,
        queryFn: () => apiRequest<StoryCharacter[]>(`/projects/${enc(projectId)}/characters`),
        staleTime: 0,
      });
      const latest = characters.flatMap((item) => item.costumes).find((item) => item.id === costume.id);
      if (!latest) throw new Error("衣装が見つかりません");
      const reference = `artifact:${artifactId}`;
      if (latest.reference_images.includes(reference)) return latest;
      return apiRequest<StoryCostume>(
        `/projects/${enc(projectId)}/characters/${enc(latest.character_id)}/costumes/${enc(latest.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ reference_images: [...latest.reference_images, reference] }),
        },
      );
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

// ---- 入力欄へ戻す ----

export type RestoredInput = {
  form: ImageForm;
  target: ImageTarget;
  /** 一部を戻せなかったときの説明。 */
  warning: string | null;
};

/**
 * 投入済みのJobの設定を入力欄の値にする。プロンプトは今のProjectの補完タグを基準に分け直し、
 * 補完タグに無いタグを自由欄へ、プロンプトに無い補完タグを外したタグへ入れる。
 */
export async function restoreFromJob(client: QueryClient, jobId: string, recipe: Recipe): Promise<RestoredInput> {
  const job = await client.fetchQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => apiRequest<GenerationJob>(`/generation-jobs/${enc(jobId)}`),
  });
  const manifest = await client.fetchQuery({
    queryKey: queryKeys.manifest(job.manifest_id),
    queryFn: () => apiRequest<GenerationManifest>(`/generation-manifests/${enc(job.manifest_id)}`),
  });
  const target: ImageTarget = {
    projectId: job.assigned_project_id,
    sceneId: job.story_scene_id ?? null,
    characterId: job.story_character_id ?? null,
    costumeId: job.story_costume_id ?? null,
  };
  let character: StoryCharacter | null = null;
  let scene: StoryScene | null = null;
  let warning: string | null = null;
  if (target.projectId !== null) {
    const projectId = target.projectId;
    try {
      const [characters, scenes] = await Promise.all([
        client.fetchQuery({
          queryKey: queryKeys.projectCharacters(projectId),
          queryFn: () => apiRequest<StoryCharacter[]>(`/projects/${enc(projectId)}/characters`),
        }),
        client.fetchQuery({
          queryKey: queryKeys.projectScenes(projectId),
          queryFn: () => apiRequest<StoryScene[]>(`/projects/${enc(projectId)}/story-scenes`),
        }),
      ]);
      character = characters.find((item) => item.id === target.characterId) ?? null;
      scene = scenes.find((item) => item.id === target.sceneId) ?? null;
    } catch (error) {
      // Projectがゴミ箱・削除済みでも設定は戻す。補完タグに分けず、プロンプト全文を自由欄へ入れる。
      const reason = error instanceof Error ? error.message : String(error);
      warning = `対象のキャラ・シーンが見つからないため、プロンプトを補完タグに分けずに戻しました (${reason})`;
    }
  }
  const costume = character?.costumes.find((item) => item.id === target.costumeId) ?? null;
  const supplement = buildSupplementTags(character, costume, scene);
  const positive = partitionPrompt(manifest.resolved_prompt, supplement.positive);
  const negativeText = manifest.parameters.negative_prompt;
  const negative = partitionPrompt(typeof negativeText === "string" ? negativeText : "", supplement.negative);
  const form: ImageForm = {
    ...formFromManifest(defaultForm(recipe), manifest),
    positiveFree: positive.free,
    excludedPositive: positive.excluded,
    negativeFree: negative.free,
    excludedNegative: negative.excluded,
  };
  return { form, target, warning };
}

/** 生成物を作ったJobのID。`/image?from_artifact=`で開いたときに使う。 */
export async function jobIdOfArtifact(client: QueryClient, artifactId: string): Promise<string> {
  const artifact = await client.fetchQuery({
    queryKey: queryKeys.artifact(artifactId),
    queryFn: () => apiRequest<ArtifactRecord>(`/artifacts/${enc(artifactId)}`),
  });
  if (artifact.job_id === null) throw new Error("この生成物は生成の設定を持っていません");
  return artifact.job_id;
}
