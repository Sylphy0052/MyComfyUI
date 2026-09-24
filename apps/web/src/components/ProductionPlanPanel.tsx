import { useEffect, useMemo, useState } from "react";

import { api, type LookProfile, type ProjectCharacterProfile } from "../api/client";
import type { CanonDescriptor, SceneEnvelope, ShotEnvelope } from "../api/aimedia";
import {
  PRESET_SLOTS,
  planFromBrief,
  planFromScene,
  presetCandidates,
  type NamedItem,
  type PlanPreset,
  type PresetSlotId,
  type ProductionPlan,
} from "../state/productionPlan";
import { findLocalCharacter, type SceneOutfits } from "../state/characterPrompt";
import { Button } from "./ui/Button";

/** ai-media の場面の `time_of_day` の値。 */
const TIME_OF_DAY_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "", label: "指定しない" },
  { value: "dawn", label: "明け方" },
  { value: "morning", label: "朝" },
  { value: "noon", label: "昼" },
  { value: "afternoon", label: "午後" },
  { value: "evening", label: "夕方" },
  { value: "night", label: "夜" },
];

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

interface Props {
  projectId: string | null;
  sceneId: string | null;
  scene: SceneEnvelope | null;
  /** 選択中のShot。台詞の話者と声 (voice_id) の割り当てを確認に出す。 */
  shot: ShotEnvelope | null;
  plan: ProductionPlan | null;
  onPlanChange: (plan: ProductionPlan | null) => void;
  profiles: LookProfile[];
  /** Projectのローカルキャラクター定義。衣装を持つキャラクターだけ場面ごとの衣装選択を出す。 */
  localCharacters: ProjectCharacterProfile[];
  /** `scene_outfits`: `{ [sceneId]: { [characterId]: outfitId } }`。 */
  sceneOutfits: SceneOutfits;
  onOutfitChange: (characterId: string, outfitId: string | null) => void;
}

/**
 * 作品制作の計画を組み、開始前に確認・修正する (F-07)。
 * 開始後は1行の要約に畳み、「組み直す」で未開始へ戻せる。
 */
export function ProductionPlanPanel({
  projectId,
  sceneId,
  scene,
  shot,
  plan,
  onPlanChange,
  profiles,
  localCharacters,
  sceneOutfits,
  onOutfitChange,
}: Props) {
  const [brief, setBrief] = useState("");
  const [canon, setCanon] = useState<CanonDescriptor[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBrief(plan?.brief ?? "");
    // 場面を切り替えたときだけ記述欄を読み直す。編集中の計画の変更では上書きしない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId]);

  // 名前の照合とキャラクターの選択肢に使う。取れなくても場面から組む操作は使える。
  useEffect(() => {
    setCanon([]);
    if (!projectId) return;
    let active = true;
    api
      .listCanon(projectId)
      .then((list) => {
        if (active) setCanon(list.items);
      })
      .catch((cause) => {
        if (active) setError(`キャラクター・場所の一覧を取得できませんでした: ${describe(cause)}`);
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  // 同じ人物がSceneのid、Canonのcanon_id、ローカル定義のidで別々に届くため、
  // idか表示名のどちらかが一致したら先に入った候補を残す。選択済みのキャラクターは
  // 名前が重なっても隠すと選択を外せなくなるため、idが一致するときだけ省く。
  const characterOptions = useMemo(() => {
    const options: NamedItem[] = [];
    const add = (item: NamedItem) => {
      if (!options.some((current) => current.id === item.id || current.name === item.name)) options.push(item);
    };
    for (const item of scene?.data.characters ?? []) add({ id: item.id, name: item.display_name || item.id });
    for (const item of canon) {
      if (item.kind === "character") add({ id: item.canon_id, name: item.display_name || item.canon_id });
    }
    for (const item of localCharacters) add({ id: item.id, name: item.name || item.id });
    for (const item of plan?.characters ?? []) {
      if (!options.some((current) => current.id === item.id)) options.push(item);
    }
    return options;
  }, [scene, canon, localCharacters, plan?.characters]);

  // 話者ごとの声。声の中身 (Voice Canon) は音声の工程でvoice_idごとに選ぶ。
  // 同じIDのVoice Canonがあればその名前を出し、無ければvoice_idを出す。
  const voiceCast = useMemo(() => {
    const voiceNames = new Map<string, string>();
    for (const item of canon) {
      if (item.kind === "voice" && item.display_name) voiceNames.set(item.canon_id, item.display_name);
    }
    const cast = new Map<string, string>();
    for (const line of shot?.data.dialogue ?? []) {
      const voice = voiceNames.get(line.voice_id) ?? line.voice_id;
      cast.set(`${line.speaker}\u0000${line.voice_id}`, `${line.speaker}: ${voice}`);
    }
    return [...cast.values()];
  }, [shot, canon]);

  if (!sceneId) return null;

  const update = (patch: Partial<ProductionPlan>) => {
    if (plan) onPlanChange({ ...plan, ...patch });
  };

  const buildFromScene = () => {
    if (!scene || scene.data.id !== sceneId) {
      setError("場面を読み込み中です。読み込み後にもう一度押してください。");
      return;
    }
    setError(null);
    onPlanChange(planFromScene(scene.data, profiles));
  };

  const buildFromBrief = () => {
    if (!brief.trim()) {
      setError("作りたい内容を日本語で書いてください。");
      return;
    }
    setError(null);
    onPlanChange(planFromBrief(sceneId, brief.trim(), canon, profiles));
  };

  if (plan?.started) {
    const presetIds = Object.values(plan.presets);
    // 一覧の取得後に見つからないPresetは削除された等で適用されない。黙って既定値へ戻さず知らせる。
    const missingCount =
      profiles.length > 0 ? presetIds.filter((id) => !profiles.some((item) => item.id === id)).length : 0;
    return (
      <section className="production-plan production-plan-summary" aria-label="制作計画">
        <span>
          計画: {plan.background.location || "場所未定"} / {plan.characters.map((item) => item.name).join("・") || "キャラクター未定"} /
          Preset {presetIds.length}件
        </span>
        {missingCount > 0 && (
          <span className="pipeline-missing-note">見つからないPreset {missingCount}件 (組み直して選び直してください)</span>
        )}
        <Button variant="ghost" onClick={() => update({ started: false })}>
          組み直す
        </Button>
      </section>
    );
  }

  const toggleCharacter = (item: NamedItem, checked: boolean) => {
    if (!plan) return;
    const others = plan.characters.filter((current) => current.id !== item.id);
    update({ characters: checked ? [...others, item] : others });
  };

  const changePreset = (slotId: PresetSlotId, profileId: string) => {
    if (!plan) return;
    const presets = { ...plan.presets };
    if (profileId) presets[slotId] = profileId;
    else delete presets[slotId];
    update({ presets });
  };

  const changeChoice = (preset: LookProfile, name: string, value: string) => {
    if (!plan) return;
    update({
      choiceValues: {
        ...plan.choiceValues,
        [preset.id]: { ...(plan.choiceValues[preset.id] ?? {}), [name]: value },
      },
    });
  };

  return (
    <section className="production-plan" aria-label="制作計画">
      <h3>作るものを指定する</h3>
      <div className="production-plan-build">
        <Button onClick={buildFromScene}>場面から組む</Button>
        <label className="production-plan-brief">
          作りたい内容
          <textarea
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
            rows={2}
            placeholder="例: 夕方の教室で、ミナとユウが話す"
          />
        </label>
        <Button onClick={buildFromBrief}>内容から組む</Button>
      </div>
      {error && <p className="error">{error}</p>}

      {plan && (
        <>
          <ol className="production-plan-steps">
            <li>
              <strong>背景</strong>
              <label>
                場所
                <input
                  value={plan.background.location}
                  onChange={(event) => update({ background: { ...plan.background, location: event.target.value } })}
                />
              </label>
              <label>
                時間帯
                <select
                  value={plan.background.timeOfDay}
                  onChange={(event) => update({ background: { ...plan.background, timeOfDay: event.target.value } })}
                >
                  {TIME_OF_DAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                補足
                <input
                  value={plan.background.note}
                  onChange={(event) => update({ background: { ...plan.background, note: event.target.value } })}
                />
              </label>
            </li>
            <li>
              <strong>キャラクター</strong>
              {characterOptions.length === 0 && <span className="muted">候補がありません。</span>}
              {characterOptions.map((item) => {
                const checked = plan.characters.some((current) => current.id === item.id);
                const localCharacter = findLocalCharacter(item, localCharacters);
                const outfits = localCharacter?.outfits ?? [];
                return (
                  <div key={item.id} className="production-plan-check">
                    <label>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggleCharacter(item, event.target.checked)}
                      />
                      {item.name}
                    </label>
                    {checked && localCharacter && outfits.length > 0 && sceneId && (
                      <select
                        aria-label={`${item.name}の衣装`}
                        value={sceneOutfits[sceneId]?.[localCharacter.id] ?? ""}
                        onChange={(event) => onOutfitChange(localCharacter.id, event.target.value || null)}
                      >
                        <option value="">既定の衣装</option>
                        {outfits.map((outfit) => (
                          <option key={outfit.id} value={outfit.id}>
                            {outfit.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </li>
            <li>
              <strong>音声・BGM</strong>
              <span className="muted">
                台詞の声 (選択中のShot): {voiceCast.length > 0 ? voiceCast.join(" / ") : "台詞なし"}。声の中身は音声の工程でvoice_idごとに選びます。
              </span>
              <label>
                BGMの雰囲気 (mood)
                <input
                  value={plan.audio.bgmMood}
                  onChange={(event) => update({ audio: { ...plan.audio, bgmMood: event.target.value } })}
                />
              </label>
              <label>
                BGMのジャンル
                <input
                  value={plan.audio.bgmGenre}
                  onChange={(event) => update({ audio: { ...plan.audio, bgmGenre: event.target.value } })}
                />
              </label>
            </li>
          </ol>

          <fieldset className="production-plan-presets">
            <legend>工程ごとのPreset</legend>
            {PRESET_SLOTS.map((slot) => {
              const candidates = presetCandidates(slot, profiles);
              const selected = candidates.find((item) => item.id === plan.presets[slot.id]);
              return (
                <div key={slot.id} className="production-plan-preset">
                  <label>
                    {slot.label}
                    <select value={selected?.id ?? ""} onChange={(event) => changePreset(slot.id, event.target.value)}>
                      <option value="">Project/場面の既定値</option>
                      {candidates.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {selected?.production_choice_inputs.map((name) => (
                    <label key={name}>
                      {name}
                      <input
                        value={plan.choiceValues[selected.id]?.[name] ?? ""}
                        onChange={(event) => changeChoice(selected, name, event.target.value)}
                        placeholder="空欄ならRecipeの既定値"
                      />
                    </label>
                  ))}
                </div>
              );
            })}
          </fieldset>

          <div className="pipeline-actions">
            <Button variant="ghost" onClick={() => onPlanChange(null)}>
              計画を消す
            </Button>
            <Button variant="primary" onClick={() => update({ started: true })}>
              この内容で開始
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

/** パネルに出す、計画のPresetの適用状況。 */
export function PlanPresetNote({ preset, blocker }: { preset: PlanPreset | null | undefined; blocker: string | null }) {
  if (!preset) return null;
  const fixed = Object.keys(preset.profile.inputs);
  return (
    <p className={blocker ? "pipeline-missing-note" : "muted"}>
      計画のPreset: {preset.profile.name}
      {!blocker && fixed.length > 0 && ` (固定: ${fixed.join(", ")})`}
      {blocker && ` — ${blocker}`}
    </p>
  );
}
