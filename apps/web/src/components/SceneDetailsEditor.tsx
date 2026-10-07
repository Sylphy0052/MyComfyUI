import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type { ProjectCharacterProfile, ProjectLocalOverrides } from "../api/client";
import type { SceneEnvelope } from "../api/aimedia";

type SceneDetail = NonNullable<ProjectLocalOverrides["scene_details"]>[string];

/** 画面に候補として出す時間帯と季節。自由記述も受け付ける。 */
const TIME_OF_DAY_CHOICES = ["朝", "昼", "夕方", "夜"];
const SEASON_CHOICES = ["春", "夏", "秋", "冬"];

/** ai-media YAMLの英語値を、初期値として表示する日本語へ読み替える。対応表に無い値はそのまま出す。 */
const TIME_OF_DAY_LABELS: Record<string, string> = {
  dawn: "朝",
  morning: "朝",
  noon: "昼",
  afternoon: "昼",
  evening: "夕方",
  night: "夜",
};
const SEASON_LABELS: Record<string, string> = {
  spring: "春",
  summer: "夏",
  autumn: "秋",
  fall: "秋",
  winter: "冬",
};

const MAX_SCENE_TAGS = 200;

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message}(${error.code})`;
  return String(error);
}

function translate(value: string | null | undefined, labels: Record<string, string>): string {
  if (!value || value === "unknown") return "";
  return labels[value] ?? value;
}

function parseTags(text: string): string[] {
  return [...new Set(text.split("\n").map((value) => value.trim()).filter(Boolean))];
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** 外部ProjectのSceneで、未設定の項目に表示するai-media YAMLの値。localのSceneは空。 */
interface SceneDefaults {
  characters: string[];
  location: string;
  time_of_day: string;
  season: string;
  tags: string[];
}

function sceneDefaults(scene: SceneEnvelope, external: boolean): SceneDefaults {
  if (!external) return { characters: [], location: "", time_of_day: "", season: "", tags: [] };
  const data = scene.data;
  return {
    characters: (data.characters ?? []).map((item) => item.id),
    location: data.location?.display_name ?? data.location?.id ?? "",
    time_of_day: translate(data.time_of_day, TIME_OF_DAY_LABELS),
    season: translate(data.season, SEASON_LABELS),
    tags: data.tags ?? [],
  };
}

/**
 * Sceneの登場キャラクター・服装・場所・時間帯・季節・タグを編集する (Issue #478)。
 *
 * 外部ProjectのSceneは書き込めないため、どちらのProjectも`local_overrides.scene_details`に
 * 保存する。服装は既存の`scene_outfits`を使う。タグを扱うのは外部ProjectのSceneだけで、
 * localのSceneのタグはSceneの編集画面から`project_scene.tags`へ保存する。
 */
export function SceneDetailsEditor({
  projectId,
  scene,
  external,
  onSaved,
}: {
  projectId: string;
  scene: SceneEnvelope;
  external: boolean;
  /** 保存したら呼ぶ。制作計画など衣装指定を使う画面の再取得を促す。 */
  onSaved?: () => void;
}) {
  const sceneId = scene.data.id;
  const defaults = useMemo(() => sceneDefaults(scene, external), [scene, external]);
  // Sceneの取り直しで同じ内容の別オブジェクトが来ても、編集中の入力を消さない。
  const defaultsKey = JSON.stringify(defaults);
  const [overrides, setOverrides] = useState<ProjectLocalOverrides | null>(null);
  const [characters, setCharacters] = useState<string[]>([]);
  const [outfits, setOutfits] = useState<Record<string, string>>({});
  const [location, setLocation] = useState("");
  const [timeOfDay, setTimeOfDay] = useState("");
  const [season, setSeason] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = (loaded: ProjectLocalOverrides) => {
    const detail: SceneDetail | undefined = loaded.scene_details?.[sceneId];
    setOverrides(loaded);
    setCharacters(detail?.characters ?? defaults.characters);
    setOutfits({ ...(loaded.scene_outfits?.[sceneId] ?? {}) });
    setLocation(detail?.location ?? defaults.location);
    setTimeOfDay(detail?.time_of_day ?? defaults.time_of_day);
    setSeason(detail?.season ?? defaults.season);
    setTags((detail?.tags ?? defaults.tags).join("\n"));
  };

  useEffect(() => {
    let active = true;
    setOverrides(null);
    setError(null);
    api.getProjectLocalOverrides(projectId)
      .then((loaded) => active && reset(loaded))
      .catch((cause) => active && setError(describe(cause)));
    return () => {
      active = false;
    };
    // resetはdefaultsとsceneIdから決まるため、defaultsは内容が変わったときだけ読み直す。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, sceneId, defaultsKey]);

  const registered: ProjectCharacterProfile[] = overrides?.characters ?? [];
  const registeredIds = new Set(registered.map((item) => item.id));
  // ai-media側にいてもキャラクター画面に未登録のIDは保存できない (422) ため、案内だけ出す。
  const unregistered = characters.filter((id) => !registeredIds.has(id));
  const selected = characters.filter((id) => registeredIds.has(id));
  const tagList = parseTags(tags);

  const toggleCharacter = (characterId: string, checked: boolean) => {
    setCharacters((current) =>
      checked ? [...current.filter((id) => id !== characterId), characterId] : current.filter((id) => id !== characterId),
    );
  };

  // 前回の保存値が無く、ai-mediaの値から変えていない項目は記録しない。
  // ai-media側の値が後で変わったときに、その値を表示し続けるため。
  const field = (
    previous: string | null | undefined,
    value: string,
    fallback: string,
  ): string | null => {
    const trimmed = value.trim();
    if (previous == null && trimmed === fallback) return null;
    return trimmed || null;
  };
  const list = (
    previous: string[] | null | undefined,
    value: string[],
    fallback: string[],
  ): string[] | null => {
    if (previous == null && sameList(value, fallback)) return null;
    return value;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (external && tagList.length > MAX_SCENE_TAGS) {
      setError(`タグは${MAX_SCENE_TAGS}個まで登録できます (${tagList.length}個)。`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 全体置換のPUTのため、保存直前に最新を読み直してからこのSceneの分だけ差し替える。
      const latest = await api.getProjectLocalOverrides(projectId);
      const previous = latest.scene_details?.[sceneId];
      const detail: SceneDetail = {
        characters: list(previous?.characters, selected, defaults.characters.filter((id) => registeredIds.has(id))),
        location: field(previous?.location, location, defaults.location),
        time_of_day: field(previous?.time_of_day, timeOfDay, defaults.time_of_day),
        season: field(previous?.season, season, defaults.season),
        tags: external ? list(previous?.tags, tagList, defaults.tags) : null,
      };
      const sceneDetails = { ...(latest.scene_details ?? {}) };
      if (Object.values(detail).every((value) => value == null)) delete sceneDetails[sceneId];
      else sceneDetails[sceneId] = detail;
      // 衣装指定は制作計画からも書かれるため、最新の指定を基にする。変えるのは、今回登場
      // キャラクターから外したキャラクターの指定と、この画面で服装を変えたキャラクターの指定だけ。
      const loadedOutfits = overrides?.scene_outfits?.[sceneId] ?? {};
      const loadedCharacters = overrides?.scene_details?.[sceneId]?.characters ?? defaults.characters;
      const forScene: Record<string, string> = { ...(latest.scene_outfits?.[sceneId] ?? {}) };
      for (const characterId of loadedCharacters) {
        if (!selected.includes(characterId)) delete forScene[characterId];
      }
      for (const characterId of selected) {
        const outfitId = outfits[characterId] ?? "";
        if (outfitId === (loadedOutfits[characterId] ?? "")) continue;
        if (outfitId) forScene[characterId] = outfitId;
        else delete forScene[characterId];
      }
      const sceneOutfits = { ...(latest.scene_outfits ?? {}) };
      if (Object.keys(forScene).length > 0) sceneOutfits[sceneId] = forScene;
      else delete sceneOutfits[sceneId];
      const saved = await api.updateProjectLocalOverrides(projectId, {
        ...latest,
        scene_details: sceneDetails,
        scene_outfits: sceneOutfits,
      });
      reset(saved);
      onSaved?.();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!overrides) {
    return <section className="panel"><p className={error ? "error" : "muted"}>{error ?? "Sceneの詳細を読込み中..."}</p></section>;
  }

  return (
    <section className="panel stack">
      <h2>Sceneの詳細</h2>
      {external && <p className="muted">未設定の項目には外部原文 (ai-media) の値を表示します。保存すると、変えた項目だけMyComfyUI側の値として記録します。場所・時間帯・季節は、空欄にして保存すると外部原文の値に戻ります。</p>}
      <form className="stack" onSubmit={submit}>
        <fieldset className="stack">
          <legend>登場キャラクターと服装</legend>
          {registered.length === 0 && <p className="muted">キャラクター画面でキャラクターを登録すると選べます。</p>}
          {registered.map((character) => {
            const checked = selected.includes(character.id);
            return (
              <div key={character.id} className="row">
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => toggleCharacter(character.id, event.target.checked)}
                  />
                  {character.name}
                </label>
                {checked && (character.outfits ?? []).length > 0 && (
                  <select
                    aria-label={`${character.name}の服装`}
                    value={outfits[character.id] ?? ""}
                    onChange={(event) => setOutfits((current) => ({ ...current, [character.id]: event.target.value }))}
                  >
                    <option value="">服装を指定しない</option>
                    {(character.outfits ?? []).map((outfit) => (
                      <option key={outfit.id} value={outfit.id}>{outfit.name}</option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
          {unregistered.length > 0 && (
            <p className="muted">キャラクター画面に未登録のため選べないID: {unregistered.join(", ")}</p>
          )}
        </fieldset>
        <label>
          場所
          <input maxLength={200} value={location} onChange={(event) => setLocation(event.target.value)} />
        </label>
        <label>
          時間帯
          <input maxLength={50} list="scene-detail-time-of-day" value={timeOfDay} onChange={(event) => setTimeOfDay(event.target.value)} />
        </label>
        <datalist id="scene-detail-time-of-day">
          {TIME_OF_DAY_CHOICES.map((value) => <option key={value} value={value} />)}
        </datalist>
        <label>
          季節
          <input maxLength={50} list="scene-detail-season" value={season} onChange={(event) => setSeason(event.target.value)} />
        </label>
        <datalist id="scene-detail-season">
          {SEASON_CHOICES.map((value) => <option key={value} value={value} />)}
        </datalist>
        {external ? (
          <label>
            タグ (1行に1個、{MAX_SCENE_TAGS}個まで。現在{tagList.length}個)
            <textarea rows={5} value={tags} onChange={(event) => setTags(event.target.value)} />
          </label>
        ) : (
          <p className="muted">タグはSceneの「編集」から変更します。</p>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button type="submit" className="primary" disabled={busy}>{busy ? "保存中..." : "保存"}</button>
        </div>
      </form>
    </section>
  );
}
