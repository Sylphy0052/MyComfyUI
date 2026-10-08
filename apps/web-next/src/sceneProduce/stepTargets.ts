import type { StoryScene } from "../api/client";
import { type ImageTarget, normalizeExtraCast } from "../imageGen/imageForm";

/** シーン画像の対象。シーンの登場キャラ全員を対象にする。先頭を主キャラ、残りを2人目以降として渡す (`/image`の`cast`と同じ)。 */
export function sceneImageTargetOf(projectId: string, scene: StoryScene): ImageTarget {
  const [first, ...rest] = scene.cast;
  return {
    projectId,
    sceneId: scene.id,
    characterId: first?.character_id ?? null,
    costumeId: first?.costume_id ?? null,
    extraCast: normalizeExtraCast(
      first?.character_id ?? null,
      rest.map((entry) => ({ characterId: entry.character_id, costumeId: entry.costume_id ?? null })),
    ),
  };
}

/** 動画の対象。シーンの登場キャラの先頭だけ。動画は1人のキャラの衣装だけを使う。 */
export function videoTargetOf(projectId: string, scene: StoryScene): ImageTarget {
  const first = scene.cast[0];
  return {
    projectId,
    sceneId: scene.id,
    characterId: first?.character_id ?? null,
    costumeId: first?.costume_id ?? null,
    extraCast: [],
  };
}

/** キャラ画像の対象。参照画像の生成はシーンに紐づけず、キャラと衣装だけを指す。 */
export function characterTargetOf(projectId: string, characterId: string, costumeId: string): ImageTarget {
  return { projectId, sceneId: null, characterId, costumeId, extraCast: [] };
}
