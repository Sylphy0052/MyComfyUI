import { useMutation } from "@tanstack/react-query";

import { apiRequest, artifactContentUrl, ApiError } from "../api/client";
import type { components } from "../api/schema";
import { artifactIdOf } from "./MediaThumb";
import { TAG_MAX, TAGS_MAX } from "./limits";
import { fileToBase64 } from "./useStory";

type ImageTagExtractRequest = components["schemas"]["ImageTagExtractRequest"];
type ImageTagExtractRead = components["schemas"]["ImageTagExtractRead"];

const INPUT_PREFIX = "input:";

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** タグの同一判定用。小文字化し、`_`と空白を同一視し、前後と連続の空白を整える。 */
export function normalizeTag(tag: string): string {
  return tag.replace(/_/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

/** 抽出結果の表示用。前後の空白を除き、正規化後に重複するものと上限を超える長さのものを落とす。 */
export function cleanExtractedTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    const key = normalizeTag(tag);
    if (key === "" || tag.length > TAG_MAX || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

/** 既存のタグの後ろへ足す。正規化して既存と重複するものは足さない。上限を超えた分は`truncated`に数える。 */
export function mergeTags(existing: string[], added: string[]): { tags: string[]; truncated: number } {
  const seen = new Set(existing.map(normalizeTag));
  const tags = [...existing];
  let truncated = 0;
  for (const raw of added) {
    const tag = raw.trim();
    const key = normalizeTag(tag);
    if (key === "" || seen.has(key)) continue;
    if (tags.length >= TAGS_MAX) {
      truncated += 1;
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return { tags, truncated };
}

/** media key (`input:<relative_path>`か`artifact:<id>`) の画像を`POST /image-tags`の入力にする。 */
async function requestBodyOf(mediaKey: string): Promise<ImageTagExtractRequest> {
  if (mediaKey.startsWith(INPUT_PREFIX)) {
    const relativePath = mediaKey.slice(INPUT_PREFIX.length);
    const extension = relativePath.split(".").pop()?.toLowerCase() ?? "";
    return { relative_path: relativePath, media_type: MEDIA_TYPE_BY_EXTENSION[extension] ?? "image/png" };
  }
  const artifactId = artifactIdOf(mediaKey);
  if (artifactId === null) throw new Error(`扱えない画像です: ${mediaKey}`);
  let response: Response;
  try {
    response = await fetch(artifactContentUrl(artifactId));
  } catch {
    throw new ApiError(0, "画像を読み込めませんでした。");
  }
  if (!response.ok) throw new ApiError(response.status, "画像を読み込めませんでした。");
  const blob = await response.blob();
  const mediaType = blob.type || "image/png";
  return {
    content_base64: await fileToBase64(new File([blob], "image", { type: mediaType })),
    media_type: mediaType,
  };
}

/** 画像のWD14 Taggerによるタグ抽出。結果は`data`に持つので、対象を変えるときは`reset()`で捨てる。 */
export function useExtractImageTags() {
  return useMutation({
    mutationFn: async (mediaKey: string): Promise<string[]> => {
      const body = await requestBodyOf(mediaKey);
      const result = await apiRequest<ImageTagExtractRead>("/image-tags", {
        method: "POST",
        body: JSON.stringify(body),
      });
      return cleanExtractedTags(result.tags);
    },
  });
}
