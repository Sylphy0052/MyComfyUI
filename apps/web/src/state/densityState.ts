import { useCallback, useState } from "react";

/**
 * 一覧の表示密度を一覧ごとにlocalStorageへ保存する。
 *
 * サムネイルを持つ一覧 (生成候補・Artifact) はサムネイル大・中・小とリストの4形式、
 * 文字だけの一覧 (キュー・Scene/Shot) は標準と詰めの2形式から選ぶ。
 */

export const GALLERY_DENSITY_OPTIONS = [
  { value: "l", label: "大" },
  { value: "m", label: "中" },
  { value: "s", label: "小" },
  { value: "list", label: "リスト" },
] as const;

export const ROW_DENSITY_OPTIONS = [
  { value: "comfortable", label: "標準" },
  { value: "compact", label: "詰め" },
] as const;

/** 一覧の種類を問わず形式の候補を同じ形で扱うための型。 */
type DensityOption = { readonly value: string; readonly label: string };

const LIST_DENSITY_OPTIONS = {
  candidates: GALLERY_DENSITY_OPTIONS,
  assets: GALLERY_DENSITY_OPTIONS,
  jobs: ROW_DENSITY_OPTIONS,
  structure: ROW_DENSITY_OPTIONS,
} as const;

export type DensityListId = keyof typeof LIST_DENSITY_OPTIONS;
export type ListDensity<K extends DensityListId> = (typeof LIST_DENSITY_OPTIONS)[K][number]["value"];
export type GalleryDensity = (typeof GALLERY_DENSITY_OPTIONS)[number]["value"];
export type RowDensity = (typeof ROW_DENSITY_OPTIONS)[number]["value"];

const DEFAULT_LIST_DENSITY: { [K in DensityListId]: ListDensity<K> } = {
  candidates: "m",
  assets: "m",
  jobs: "comfortable",
  structure: "comfortable",
};

const STORAGE_KEY = "mycomfyui.density.v1";

/**
 * localStorageが使えない・JSONとして読めない・オブジェクトでない場合は空として扱う。
 * 空なら各一覧はreadListDensityで既定値へ戻り、壊れた保存値は次の切替時に上書きされる。
 */
function readStoredDensityMap(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 保存値が壊れているか、形式の候補から外れていれば、一覧ごとの既定値へ戻す。 */
export function readListDensity<K extends DensityListId>(listId: K): ListDensity<K> {
  const stored = readStoredDensityMap()[listId];
  const options: readonly DensityOption[] = LIST_DENSITY_OPTIONS[listId];
  const matched = options.find((option) => option.value === stored);
  return matched ? (matched.value as ListDensity<K>) : DEFAULT_LIST_DENSITY[listId];
}

/** 他の一覧の保存値を消さないよう、書き込み直前に読み直してから1項目だけ差し替える。 */
export function persistListDensity<K extends DensityListId>(listId: K, density: ListDensity<K>): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...readStoredDensityMap(), [listId]: density }),
    );
  } catch {
    // 書き込めない環境でも切替自体は効かせる。次回起動時の復元だけが効かなくなる。
  }
}

export function useListDensity<K extends DensityListId>(
  listId: K,
): [ListDensity<K>, (density: ListDensity<K>) => void] {
  const [density, setDensity] = useState<ListDensity<K>>(() => readListDensity(listId));
  const update = useCallback(
    (next: ListDensity<K>) => {
      setDensity(next);
      persistListDensity(listId, next);
    },
    [listId],
  );
  return [density, update];
}
