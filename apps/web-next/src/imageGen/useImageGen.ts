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
import { defaultForm, formFromManifest, TXT2IMG_TEMPLATE, type ImageForm, type ImageTarget } from "./imageForm";
import { buildSupplementTags, partitionPrompt } from "./promptTags";

const enc = encodeURIComponent;

// ---- 入力欄と結果欄の保存 ----

/** 入力欄の内容と対象。最後に使った値をブラウザに残し、画面を離れて戻っても続きから書ける。 */
export type StoredInput = { form: ImageForm | null; target: ImageTarget | null };

/** 結果欄に出すJob。枚数はプレースホルダの数に使う。 */
export type ResultEntry = { jobId: string; count: number };

/** 結果欄に残すJobの数。古いものから落とす。 */
const RESULTS_MAX = 30;

export function useStoredInput() {
  return useLocalStorage<StoredInput>({
    key: "web-next:image-input",
    defaultValue: { form: null, target: null },
    // 初回の描画から保存済みの値を使う。既定値で描いてから差し替えると、対象の復元が既定値で上書きされる。
    getInitialValueInEffect: false,
  });
}

export function useResultEntries() {
  const [entries, setEntries] = useLocalStorage<ResultEntry[]>({
    key: "web-next:image-results",
    defaultValue: [],
    getInitialValueInEffect: false,
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
 * queryKeyと応答の形はProject画面 (`useCharacters`・`useScenes`) と同じにし、キャッシュを共有する。
 */
export function useProjectStory(projectId: string | null) {
  const characters = useQuery({
    queryKey: queryKeys.projectCharacters(projectId ?? ""),
    queryFn: () => apiRequest<StoryCharacter[]>(`/projects/${enc(projectId ?? "")}/characters`),
    enabled: projectId !== null,
  });
  const scenes = useQuery({
    queryKey: queryKeys.projectScenes(projectId ?? ""),
    queryFn: () => apiRequest<StoryScene[]>(`/projects/${enc(projectId ?? "")}/story-scenes`),
    select: (items) => [...items].sort((a, b) => a.sequence - b.sequence),
    enabled: projectId !== null,
  });
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
    refetchInterval: (query) => (isActive(query.state.data) ? ACTIVE_POLL_MS : false),
  });
}

/** Jobの画像の生成物。Workflowのスナップショットとゴミ箱のものは除く。 */
export function useJobImages(jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.jobArtifacts(jobId),
    queryFn: () => apiRequest<ArtifactRecord[]>(`/generation-jobs/${enc(jobId)}/artifacts`),
    select: (items) => items.filter((item) => item.kind === "image" && item.deleted_at === null),
    enabled,
  });
}

// ---- 結果のカードの操作 ----

/** 生成物の応答を、そのJobの生成物一覧へ反映する。 */
function putArtifact(client: QueryClient, saved: ArtifactRecord): void {
  if (saved.job_id === null) return;
  client.setQueryData<ArtifactRecord[]>(queryKeys.jobArtifacts(saved.job_id), (list) =>
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
        if (artifact.decision === "rejected") await setDecision(artifact.id, "undecided");
        await apiRequest(slotPath, { method: "PUT", body: JSON.stringify({ artifact_id: artifact.id }) });
        return;
      }
      if (action === "release") {
        await apiRequest(slotPath, { method: "DELETE" });
        return;
      }
      if (action === "reject" && adopted) await apiRequest(slotPath, { method: "DELETE" });
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
    mutationFn: ({ costume, artifactId }: { costume: StoryCostume; artifactId: string }) =>
      apiRequest<StoryCostume>(
        `/projects/${enc(projectId)}/characters/${enc(costume.character_id)}/costumes/${enc(costume.id)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ reference_images: [...costume.reference_images, `artifact:${artifactId}`] }),
        },
      ),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

// ---- 入力欄へ戻す ----

export type RestoredInput = { form: ImageForm; target: ImageTarget };

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
  if (target.projectId !== null) {
    const projectId = target.projectId;
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
  return { form, target };
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
