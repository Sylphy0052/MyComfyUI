import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type { LookProfile, Recipe } from "../api/client";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { PromptFieldsEditor } from "./PromptFieldsEditor";
import { mergePromptFields, splitPromptFields } from "../prompt/fields";
import type { PromptFieldName } from "../prompt/fields";
import { productionChoiceWarning, subscribeLookProfilesChanged } from "../preset/productionChoices";

interface Props {
  kind: string;
  recipe: Recipe | null;
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return String(error);
}

export function LookProfileManager({
  kind,
  recipe,
  selectedIds,
  onSelectionChange,
}: Props) {
  const [profiles, setProfiles] = useState<LookProfile[]>([]);
  const [query, setQuery] = useState("");
  const [pickId, setPickId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"general" | "style" | "character" | "background">("general");
  const [description, setDescription] = useState("");
  const [restJson, setRestJson] = useState("{}");
  const [promptFields, setPromptFields] = useState<Partial<Record<PromptFieldName, string>>>({});
  const [scopeRecipeId, setScopeRecipeId] = useState<string | null>(null);
  const [choiceInputs, setChoiceInputs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // 一覧を取得するまでは適用中のPresetの互換を判定できない。空の一覧で選択を消さないために持つ。
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let active = true;
    api.listLookProfiles({ kind, limit: 200 })
      .then((items) => { if (active) { setProfiles(items); setLoaded(true); } })
      .catch((cause) => { if (active) setError(describe(cause)); });
    return () => { active = false; };
  }, [kind, reload]);

  // 候補ギャラリーなど、別の場所で作られたPresetを一覧へすぐ出す。
  useEffect(() => subscribeLookProfilesChanged(() => setReload((current) => current + 1)), []);

  const choiceLabels = useMemo(() => {
    const schema = (recipe?.input_schema ?? {}) as Record<string, unknown>;
    const labels = new Map<string, string>();
    for (const [inputName, entry] of Object.entries(schema)) {
      const label = entry && typeof entry === "object" ? (entry as Record<string, unknown>).label : undefined;
      labels.set(inputName, typeof label === "string" && label ? label : inputName);
    }
    for (const inputName of choiceInputs) {
      if (!labels.has(inputName)) labels.set(inputName, inputName);
    }
    return labels;
  }, [recipe?.input_schema, choiceInputs]);
  const choiceWarning = productionChoiceWarning(choiceInputs.length);

  const visibleProfiles = useMemo(
    () => profiles.filter((profile) => profile.name.toLowerCase().includes(query.trim().toLowerCase())),
    [profiles, query],
  );

  const isCompatible = (profile: LookProfile): boolean => {
    if (profile.recipe_id !== null && profile.recipe_id !== recipe?.id) return false;
    if (!recipe) return profile.recipe_id === null;
    return Object.keys(profile.inputs).every((name) => name in recipe.input_schema);
  };

  useEffect(() => {
    if (!loaded) return;
    const compatible = new Set(
      profiles
        .filter(isCompatible)
        .map((profile) => profile.id),
    );
    const next = selectedIds.filter((id) => compatible.has(id));
    if (next.length !== selectedIds.length) onSelectionChange(next);
  }, [loaded, profiles, recipe?.id, selectedIds]);

  const selected = useMemo(
    () => selectedIds.map((id) => profiles.find((profile) => profile.id === id)).filter((item): item is LookProfile => Boolean(item)),
    [profiles, selectedIds],
  );

  const resetEditor = () => {
    setEditingId(null);
    setName("");
    setCategory("general");
    setDescription("");
    setRestJson("{}");
    setPromptFields({});
    setScopeRecipeId(recipe?.id ?? null);
    setChoiceInputs([]);
  };

  const edit = (profile: LookProfile, duplicate = false) => {
    setEditingId(duplicate ? null : profile.id);
    setName(duplicate ? `${profile.name}のコピー` : profile.name);
    setCategory(profile.category as typeof category);
    setDescription(profile.description ?? "");
    const split = splitPromptFields(profile.inputs);
    setRestJson(JSON.stringify(split.rest, null, 2));
    setPromptFields(split.prompts);
    setScopeRecipeId(profile.recipe_id);
    setChoiceInputs(profile.production_choice_inputs ?? []);
  };

  const toggleChoiceInput = (inputName: string, checked: boolean) => {
    setChoiceInputs((current) => (
      checked ? [...current, inputName] : current.filter((item) => item !== inputName)
    ));
  };

  const changePromptField = (fieldName: PromptFieldName, value: string) => {
    setPromptFields((current) => ({ ...current, [fieldName]: value }));
  };

  const addPromptField = (fieldName: PromptFieldName) => {
    setPromptFields((current) => ({ ...current, [fieldName]: "" }));
  };

  const removePromptField = (fieldName: PromptFieldName) => {
    setPromptFields((current) => {
      const next = { ...current };
      delete next[fieldName];
      return next;
    });
  };

  const save = async () => {
    let inputs: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(restJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("inputsはJSON objectで入力してください。");
      }
      inputs = mergePromptFields(parsed as Record<string, unknown>, promptFields);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    if (!name.trim()) {
      setError("名前を入力してください。");
      return;
    }
    if (
      editingId &&
      !window.confirm("保存済みのPresetを上書きします。上書き前の内容には戻せません。続けますか？")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        await api.updateLookProfile(editingId, {
          name: name.trim(),
          category,
          description: description.trim() || null,
          recipe_id: scopeRecipeId,
          inputs,
          production_choice_inputs: choiceInputs,
        });
      } else {
        await api.createLookProfile({
          name: name.trim(),
          kind: kind as "image" | "video" | "voice" | "music" | "compose",
          category,
          description: description.trim() || null,
          recipe_id: scopeRecipeId,
          inputs,
          production_choice_inputs: choiceInputs,
        });
      }
      resetEditor();
      setReload((current) => current + 1);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (profile: LookProfile) => {
    if (!window.confirm(`Preset「${profile.name}」を削除しますか。`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteLookProfile(profile.id);
      onSelectionChange(selectedIds.filter((id) => id !== profile.id));
      setReload((current) => current + 1);
      if (editingId === profile.id) resetEditor();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= selectedIds.length) return;
    const next = [...selectedIds];
    [next[index], next[target]] = [next[target], next[index]];
    onSelectionChange(next);
  };

  return (
    <details className="stack">
      <summary>重ねるPreset {selectedIds.length}件適用</summary>
      <div className="stack">
        {error && <p className="error">{error}</p>}
        <label>検索<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="row">
          <select value={pickId} onChange={(event) => setPickId(event.target.value)}>
            <option value="">追加するPreset</option>
            {visibleProfiles.filter((profile) => !selectedIds.includes(profile.id)).map((profile) => (
              <option key={profile.id} value={profile.id} disabled={!isCompatible(profile)}>
                {profile.name} / {profile.category}{!isCompatible(profile) ? " (現在のRecipeでは利用不可)" : ""}
              </option>
            ))}
          </select>
          <button type="button" disabled={!pickId} onClick={() => { onSelectionChange([...selectedIds, pickId]); setPickId(""); }}>適用</button>
          <button type="button" onClick={resetEditor}>新規</button>
        </div>
        <ul className="list plain">
          {visibleProfiles.map((profile) => (
            <li key={profile.id} className="row">
              <span>{profile.name} / {profile.category}</span>
              {profile.production_choice_inputs.length > 0 && <span className="muted">モードBで選ばせる: {profile.production_choice_inputs.join(", ")}</span>}
              <button type="button" disabled={!isCompatible(profile) || selectedIds.includes(profile.id)} onClick={() => onSelectionChange([...selectedIds, profile.id])}>適用</button>
              <button type="button" onClick={() => edit(profile)}>編集</button>
              <button type="button" onClick={() => edit(profile, true)}>複製</button>
              <button type="button" className="danger-button" disabled={busy} onClick={() => void remove(profile)}>削除</button>
            </li>
          ))}
        </ul>
        <ol>
          {selected.map((profile, index) => (
            <li key={profile.id}>
              <span>{profile.name}（{profile.category}）</span>{" "}
              <IconButton icon={<Icon name="arrow-up" />} label="上へ移動" variant="secondary" disabled={index === 0} onClick={() => move(index, -1)} />
              <IconButton icon={<Icon name="arrow-down" />} label="下へ移動" variant="secondary" disabled={index === selected.length - 1} onClick={() => move(index, 1)} />
              <button type="button" onClick={() => onSelectionChange(selectedIds.filter((id) => id !== profile.id))}>適用解除</button>
              <button type="button" onClick={() => edit(profile)}>編集</button>
              <button type="button" onClick={() => edit(profile, true)}>複製</button>
              <button type="button" className="danger-button" disabled={busy} onClick={() => void remove(profile)}>削除</button>
            </li>
          ))}
        </ol>
        <fieldset className="stack" disabled={busy}>
          <legend>{editingId ? "Preset編集" : "Preset作成"}</legend>
          <label>名前<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>分類<select value={category} onChange={(event) => setCategory(event.target.value as typeof category)}><option value="general">general</option><option value="style">画風</option><option value="character">人物</option><option value="background">背景</option></select></label>
          <label>説明<textarea value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <label><input type="checkbox" checked={scopeRecipeId !== null} disabled={!recipe && scopeRecipeId === null} onChange={(event) => setScopeRecipeId(event.target.checked ? recipe?.id ?? null : null)} />Recipe専用</label>
          {scopeRecipeId && <p className="muted">対象Recipe:{scopeRecipeId}</p>}
          <PromptFieldsEditor
            idPrefix="look-profile"
            values={promptFields}
            onChange={changePromptField}
            onAdd={addPromptField}
            onRemove={removePromptField}
          />
          <label>入力overlay（Prompt、Negative Prompt以外）<textarea className="mono" rows={10} value={restJson} onChange={(event) => setRestJson(event.target.value)} /></label>
          <fieldset className="stack">
            <legend>モードBで選ばせる項目</legend>
            {choiceLabels.size === 0 ? <p className="muted">Recipeを選ぶと、入力から選べます。</p> : (
              [...choiceLabels].map(([inputName, label]) => (
                <label key={inputName}>
                  <input type="checkbox" checked={choiceInputs.includes(inputName)} onChange={(event) => toggleChoiceInput(inputName, event.target.checked)} />
                  {label}
                </label>
              ))
            )}
            <p className="muted">入力overlayで固定した項目とは重ねられません。固定も選ばせる指定もしない項目は、キャラクター・場面・Recipe既定値から自動で埋まります。</p>
            {choiceWarning && <p className="error" role="status">{choiceWarning}</p>}
          </fieldset>
          <p className="muted">後に並ぶPresetが前の値を上書きします。runtime入力は全Presetより優先されます。</p>
          <button type="button" className="primary" onClick={() => void save()}>{busy ? "保存中..." : "保存"}</button>
        </fieldset>
      </div>
    </details>
  );
}
