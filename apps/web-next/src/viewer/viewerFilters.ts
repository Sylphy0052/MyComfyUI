import type { ArtifactDecision } from "../api/client";

/** 一覧を出すタブ。 */
export type MediaTabId = "image" | "video" | "voice" | "bgm";

/** タブ。一覧のタブ (`MediaTabId`) とゴミ箱。 */
export type ViewerTab = MediaTabId | "trash";

/** 一覧のタブごとの`GET /media-items`の種別。音声とBGMは`kind`が同じで`audioClass`が違う。 */
export type MediaTabSpec = {
  kind: "image" | "video" | "audio";
  audioClass?: "voice" | "bgm";
  /** 一覧が空のときの文言。 */
  emptyText: string;
};

export const MEDIA_TABS: Record<MediaTabId, MediaTabSpec> = {
  image: { kind: "image", emptyText: "条件に合う画像はありません" },
  video: { kind: "video", emptyText: "条件に合う動画はありません" },
  voice: { kind: "audio", audioClass: "voice", emptyText: "条件に合う音声はありません" },
  bgm: { kind: "audio", audioClass: "bgm", emptyText: "条件に合うBGMはありません" },
};

/** 紐づけ先。Project → Scene → キャラ → 衣装の順に絞り込む。フィルタと付け替えで共用する。 */
export type StoryLinks = {
  project: string | null;
  scene: string | null;
  character: string | null;
  outfit: string | null;
};

export const NO_LINKS: StoryLinks = { project: null, scene: null, character: null, outfit: null };

export type ViewerFilters = StoryLinks & {
  decision: ArtifactDecision | null;
  /** Project無しだけ。Projectの絞り込みとは同時に使えない (APIが422を返す)。 */
  unassigned: boolean;
  /** 作成日の範囲 (`YYYY-MM-DD`)。`to`はその日の終わりまでを含む。 */
  from: string | null;
  to: string | null;
};

const DECISIONS: readonly ArtifactDecision[] = ["undecided", "accepted", "rejected"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function dateParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value !== null && DATE_PATTERN.test(value) ? value : null;
}

/** `tab=`を読む。読めない値は画像タブにする。 */
export function readTab(params: URLSearchParams): ViewerTab {
  const tab = params.get("tab");
  return tab === "trash" || tab === "video" || tab === "voice" || tab === "bgm" ? tab : "image";
}

/** URLのフィルタを読む。読めない値は指定なしとして扱う。 */
export function readFilters(params: URLSearchParams): ViewerFilters {
  const decision = params.get("decision");
  const unassigned = params.get("unassigned") === "1" || params.get("unassigned") === "true";
  // Project無しの生成物には紐づけが無いので、紐づけの絞り込みは外す。
  const links: StoryLinks = unassigned
    ? NO_LINKS
    : {
        project: params.get("project") || null,
        scene: params.get("scene") || null,
        character: params.get("character") || null,
        outfit: params.get("outfit") || null,
      };
  return {
    ...links,
    decision: DECISIONS.find((value) => value === decision) ?? null,
    unassigned,
    from: dateParam(params, "from"),
    to: dateParam(params, "to"),
  };
}

const FILTER_PARAMS = ["project", "scene", "character", "outfit", "decision", "unassigned", "from", "to"] as const;

/** フィルタをURLへ書く。フィルタ以外の項目 (`tab`など) は残す。 */
export function writeFilters(params: URLSearchParams, filters: ViewerFilters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const name of FILTER_PARAMS) next.delete(name);
  const values: Record<(typeof FILTER_PARAMS)[number], string | null> = {
    project: filters.project,
    scene: filters.scene,
    character: filters.character,
    outfit: filters.outfit,
    decision: filters.decision,
    unassigned: filters.unassigned ? "1" : null,
    from: filters.from,
    to: filters.to,
  };
  for (const name of FILTER_PARAMS) {
    const value = values[name];
    if (value) next.set(name, value);
  }
  return next;
}

/** `GET /media-items`の絞り込み (ページ指定を除く)。タブの種別 (`spec`) の生成物だけを出す。 */
export function mediaItemsQuery(
  spec: MediaTabSpec,
  filters: ViewerFilters,
  overrides: { decision?: ArtifactDecision } = {},
): URLSearchParams {
  const query = new URLSearchParams({ kind: spec.kind });
  if (spec.audioClass) query.set("audio_class", spec.audioClass);
  const decision = overrides.decision ?? filters.decision;
  if (filters.unassigned) query.set("unassigned", "true");
  if (filters.project) query.set("project_id", filters.project);
  if (filters.scene) query.set("story_scene_id", filters.scene);
  if (filters.character) query.set("story_character_id", filters.character);
  if (filters.outfit) query.set("story_costume_id", filters.outfit);
  if (decision) query.set("decision", decision);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  return query;
}
