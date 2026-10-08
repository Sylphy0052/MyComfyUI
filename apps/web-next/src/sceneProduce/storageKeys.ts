import type { BgmStorageKeys } from "../bgm/useBgm";
import type { ImageStorageKeys } from "../imageGen/imageForm";
import type { VideoStorageKeys } from "../pages/VideoPage";
import type { VoiceStorageKeys } from "../voice/useVoice";

// シーン生成の各工程が入力欄と結果欄を残すlocalStorageのキー。`/image`などの保存値とも、ほかのシーンとも混ざらないよう
// 工程・シーンごとに分ける。工程の画面と「残りを一括実行」が同じキーを読み書きするので、ここに集める。

/** キャラ画像。衣装ごとにも分け、別のキャラの入力値・結果・外したタグを持ち越さない。 */
export function characterKeysOf(characterId: string, costumeId: string): ImageStorageKeys {
  const suffix = `${characterId}:${costumeId}`;
  return {
    input: `web-next:scene-produce-character-input:${suffix}`,
    results: `web-next:scene-produce-character-results:${suffix}`,
    sweeps: `web-next:scene-produce-character-sweeps:${suffix}`,
  };
}

export function sceneImageKeysOf(sceneId: string): ImageStorageKeys {
  return {
    input: `web-next:scene-produce-scene-image-input:${sceneId}`,
    results: `web-next:scene-produce-scene-image-results:${sceneId}`,
    sweeps: `web-next:scene-produce-scene-image-sweeps:${sceneId}`,
  };
}

export function voiceKeysOf(sceneId: string): VoiceStorageKeys {
  return {
    input: `web-next:scene-produce-voice-input:${sceneId}`,
    results: `web-next:scene-produce-voice-results:${sceneId}`,
  };
}

export function bgmKeysOf(sceneId: string): BgmStorageKeys {
  return {
    input: `web-next:scene-produce-bgm-input:${sceneId}`,
    results: `web-next:scene-produce-bgm-results:${sceneId}`,
  };
}

export function videoKeysOf(sceneId: string): VideoStorageKeys {
  return {
    input: `web-next:scene-produce-video-input:${sceneId}`,
    results: `web-next:scene-produce-video-results:${sceneId}`,
  };
}

/** 統合は入力欄を持たず、結果欄だけ残す。 */
export function composeResultsKeyOf(sceneId: string): string {
  return `web-next:scene-produce-compose-results:${sceneId}`;
}

/**
 * `@mantine/hooks`の`useLocalStorage`が、同じ画面内の別のフックへ値の変更を知らせるイベント名。
 * Mantineの公開APIではなく内部の実装に依存している。出典は`@mantine/hooks`の`use-local-storage/create-storage`
 * (`type === "localStorage" ? "mantine-local-storage" : ...`)。Mantineを上げたときは、結果欄が一括実行の追記で更新されるか確かめる。
 */
const MANTINE_LOCAL_STORAGE_EVENT = "mantine-local-storage";

/**
 * 結果欄のlocalStorageの先頭へ1件足す。開いている結果欄は、`useLocalStorage`と同じイベントで更新される。
 * 結果欄の各フックと同じく、同じ`jobId`の古い要素は取り除き、`max`件を超えた分は古い方から落とす。
 * `max`には、書き込み先の結果欄のフックが持つ`RESULTS_MAX`を渡す。壊れた保存値は空として扱う。
 */
export function appendResultEntry<T extends { jobId: string }>(key: string, entry: T, max: number): void {
  let current: T[] = [];
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(key) ?? "[]");
    if (Array.isArray(raw)) {
      current = raw.filter(
        (item): item is T =>
          typeof item === "object" && item !== null && typeof (item as { jobId?: unknown }).jobId === "string",
      );
    }
  } catch {
    current = [];
  }
  const next = [entry, ...current.filter((item) => item.jobId !== entry.jobId)].slice(0, max);
  try {
    window.localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(MANTINE_LOCAL_STORAGE_EVENT, { detail: { key, value: next } }));
  } catch {
    // 結果欄への追記は付随機能で、書けなくても採用は別に書かれる。容量超過などで`setItem`が投げても、
    // 投入済みのJobを孤児にして一括実行を止める理由にならないので、握って先へ進める。
  }
}
