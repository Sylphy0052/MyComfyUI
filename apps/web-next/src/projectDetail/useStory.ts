import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  apiRequest,
  type ArtifactRecord,
  type ImageReference,
  type StoryCharacter,
  type StoryCharacterBody,
  type StoryCostume,
  type StoryCostumeBody,
  type StoryScene,
  type StorySceneAdoption,
  type StorySceneBody,
  type VoiceReference,
} from "../api/client";
import { queryKeys } from "../api/queryKeys";

const enc = encodeURIComponent;

/** 手元のファイルをbase64の本文だけにする (`data:...;base64,`の頭を落とす)。 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      resolve(text.slice(text.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("ファイルを読み込めませんでした"));
    reader.readAsDataURL(file);
  });
}

/** `/image-references`と`/voice-references`の戻りを、キャラ・衣装のmedia keyにする。 */
export function inputMediaKey(relativePath: string): string {
  return `input:${relativePath}`;
}

// ---- キャラクター・衣装 ----

export function useCharacters(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectCharacters(projectId),
    queryFn: () => apiRequest<StoryCharacter[]>(`/projects/${enc(projectId)}/characters`),
  });
}

export function useSaveCharacter(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: StoryCharacterBody }) =>
      id === null
        ? apiRequest<StoryCharacter>(`/projects/${enc(projectId)}/characters`, {
            method: "POST",
            body: JSON.stringify(body),
          })
        : apiRequest<StoryCharacter>(`/projects/${enc(projectId)}/characters/${enc(id)}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          }),
    onSuccess: (saved) => {
      // 取り直しを待つ間も「保存済みの値」が最新になるよう、応答を先にキャッシュへ入れる。
      client.setQueryData<StoryCharacter[]>(queryKeys.projectCharacters(projectId), (list = []) =>
        list.some((item) => item.id === saved.id)
          ? list.map((item) => (item.id === saved.id ? saved : item))
          : [...list, saved],
      );
      return client.invalidateQueries({ queryKey: queryKeys.projectCharacters(projectId) });
    },
  });
}

/** メモは生成物そのものの項目なので、衣装の保存と同じ操作の中で一緒に更新する。 */
export function useSaveCostume(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({
      characterId,
      costumeId,
      body,
      memos,
    }: {
      characterId: string;
      costumeId: string | null;
      body: StoryCostumeBody;
      /** 変えたメモだけ。キーは生成物のID。 */
      memos: Record<string, string>;
    }) => {
      const base = `/projects/${enc(projectId)}/characters/${enc(characterId)}/costumes`;
      const saved =
        costumeId === null
          ? await apiRequest<StoryCostume>(base, { method: "POST", body: JSON.stringify(body) })
          : await apiRequest<StoryCostume>(`${base}/${enc(costumeId)}`, {
              method: "PATCH",
              body: JSON.stringify(body),
            });
      for (const [artifactId, memo] of Object.entries(memos)) {
        await apiRequest<ArtifactRecord>(`/artifacts/${enc(artifactId)}`, {
          method: "PATCH",
          body: JSON.stringify({ memo }),
        });
        await client.invalidateQueries({ queryKey: queryKeys.artifact(artifactId) });
      }
      return saved;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projectCharacters(projectId) }),
  });
}

export function useArtifact(artifactId: string) {
  return useQuery({
    queryKey: queryKeys.artifact(artifactId),
    queryFn: () => apiRequest<ArtifactRecord>(`/artifacts/${enc(artifactId)}`),
  });
}

export function useUploadImageReference() {
  return useMutation({
    mutationFn: async (file: File) =>
      apiRequest<ImageReference>("/image-references", {
        method: "POST",
        body: JSON.stringify({
          file_name: file.name,
          media_type: file.type,
          content_base64: await fileToBase64(file),
        }),
      }),
  });
}

export function useUploadVoiceReference() {
  return useMutation({
    mutationFn: async (file: File) =>
      apiRequest<VoiceReference>("/voice-references", {
        method: "POST",
        body: JSON.stringify({ file_name: file.name, content_base64: await fileToBase64(file) }),
      }),
  });
}

// ---- シーン ----

export function useScenes(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectScenes(projectId),
    queryFn: () => apiRequest<StoryScene[]>(`/projects/${enc(projectId)}/story-scenes`),
    select: (items) => [...items].sort((a, b) => a.sequence - b.sequence),
  });
}

export function useSaveScene(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: StorySceneBody }) =>
      id === null
        ? apiRequest<StoryScene>(`/projects/${enc(projectId)}/story-scenes`, {
            method: "POST",
            body: JSON.stringify(body),
          })
        : apiRequest<StoryScene>(`/projects/${enc(projectId)}/story-scenes/${enc(id)}`, {
            method: "PATCH",
            body: JSON.stringify(body),
          }),
    onSuccess: (saved) => {
      client.setQueryData<StoryScene[]>(queryKeys.projectScenes(projectId), (list = []) =>
        list.some((item) => item.id === saved.id)
          ? list.map((item) => (item.id === saved.id ? saved : item))
          : [...list, saved],
      );
      return client.invalidateQueries({ queryKey: queryKeys.projectScenes(projectId) });
    },
  });
}

export function useReorderScenes(projectId: string) {
  const client = useQueryClient();
  const key = queryKeys.projectScenes(projectId);
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiRequest<StoryScene[]>(`/projects/${enc(projectId)}/story-scenes/reorder`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    // 一覧がドロップの瞬間に並び替わるよう、保存の応答を待たずに順序を差し替える。失敗したら戻す。
    onMutate: async (ids) => {
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<StoryScene[]>(key);
      client.setQueryData<StoryScene[]>(key, (list = []) =>
        list.map((scene) => ({ ...scene, sequence: ids.indexOf(scene.id) + 1 })),
      );
      return { previous };
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) client.setQueryData(key, context.previous);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });
}

export function useSceneAdoptions(projectId: string, sceneId: string | null) {
  return useQuery({
    queryKey: queryKeys.sceneAdoptions(projectId, sceneId ?? ""),
    queryFn: () =>
      apiRequest<StorySceneAdoption[]>(`/projects/${enc(projectId)}/story-scenes/${enc(sceneId ?? "")}/adoptions`),
    enabled: sceneId !== null,
  });
}
