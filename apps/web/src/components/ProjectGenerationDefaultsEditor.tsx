import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import { ApiError, api } from "../api/client";
import type {
  ProjectGenerationDefaults,
  ProjectGenerationDefaultsRead,
  Recipe,
} from "../api/client";
import { PromptFieldsEditor } from "./PromptFieldsEditor";
import { mergePromptFields, splitPromptFields } from "../prompt/fields";
import type { PromptFieldName } from "../prompt/fields";

type Kind = "image" | "video" | "music" | "voice" | "compose";
type Profile = NonNullable<ProjectGenerationDefaults[Kind]>;

const KINDS: { value: Kind; label: string }[] = [
  { value: "image", label: "画像" },
  { value: "video", label: "動画" },
  { value: "music", label: "音楽" },
  { value: "voice", label: "音声" },
  { value: "compose", label: "合成" },
];

const emptyProfile = (): Profile => ({
  recipe_id: null,
  inputs: {},
  character_references: [],
  style: null,
  color_tone: null,
  voice_cast: null,
  bgm_policy: null,
  output_directory: null,
  filename_pattern: null,
});

function normalize(defaults: ProjectGenerationDefaults): Record<Kind, Profile> {
  return Object.fromEntries(
    KINDS.map(({ value }) => [value, { ...emptyProfile(), ...defaults[value] }]),
  ) as Record<Kind, Profile>;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  return String(error);
}

export function ProjectGenerationDefaultsEditor({
  projectId,
  onCancel,
  onSaved,
}: {
  projectId: string;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState<Kind>("image");
  const [profiles, setProfiles] = useState<Record<Kind, Profile> | null>(null);
  const [restText, setRestText] = useState<Record<Kind, string> | null>(null);
  const [promptValues, setPromptValues] = useState<Record<
    Kind,
    Partial<Record<PromptFieldName, string>>
  > | null>(null);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [result, setResult] = useState<ProjectGenerationDefaultsRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.getProjectGenerationDefaults(projectId), api.listRecipes()])
      .then(([loaded, recipeList]) => {
        if (!active) return;
        const normalized = normalize(loaded.defaults);
        setProfiles(normalized);
        const split = Object.fromEntries(
          KINDS.map(({ value }) => [value, splitPromptFields(normalized[value].inputs ?? {})]),
        ) as Record<Kind, ReturnType<typeof splitPromptFields>>;
        setRestText(
          Object.fromEntries(
            KINDS.map(({ value }) => [value, JSON.stringify(split[value].rest, null, 2)]),
          ) as Record<Kind, string>,
        );
        setPromptValues(
          Object.fromEntries(KINDS.map(({ value }) => [value, split[value].prompts])) as Record<
            Kind,
            Partial<Record<PromptFieldName, string>>
          >,
        );
        setRecipes(recipeList);
        setResult(loaded);
      })
      .catch((cause) => active && setError(describe(cause)));
    return () => {
      active = false;
    };
  }, [projectId]);

  const profile = profiles?.[kind] ?? null;
  const matchingRecipes = useMemo(
    () => recipes.filter((recipe) => recipe.kind === kind),
    [kind, recipes],
  );
  const selectedRecipe = matchingRecipes.find(
    (recipe) => recipe.id === profile?.recipe_id,
  );

  const update = (values: Partial<Profile>) => {
    setProfiles((current) =>
      current
        ? { ...current, [kind]: { ...current[kind], ...values } }
        : current,
    );
  };

  const changePromptField = (name: PromptFieldName, value: string) => {
    setPromptValues((current) =>
      current ? { ...current, [kind]: { ...current[kind], [name]: value } } : current,
    );
  };

  const addPromptField = (name: PromptFieldName) => {
    setPromptValues((current) =>
      current ? { ...current, [kind]: { ...current[kind], [name]: "" } } : current,
    );
  };

  const removePromptField = (name: PromptFieldName) => {
    setPromptValues((current) => {
      if (!current) return current;
      const next = { ...current[kind] };
      delete next[name];
      return { ...current, [kind]: next };
    });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!profiles || !restText || !promptValues) return;
    setBusy(true);
    setError(null);
    try {
      const parsedRest = Object.fromEntries(
        KINDS.map(({ value }) => [value, JSON.parse(restText[value])]),
      ) as Record<Kind, Record<string, unknown>>;
      const payload = Object.fromEntries(
        KINDS.map(({ value }) => [
          value,
          {
            ...profiles[value],
            inputs: mergePromptFields(parsedRest[value], promptValues[value]),
          },
        ]),
      ) as ProjectGenerationDefaults;
      const saved = await api.updateProjectGenerationDefaults(projectId, payload);
      setResult(saved);
      await onSaved();
    } catch (cause) {
      setError(
        cause instanceof SyntaxError
          ? "実行入力はJSONオブジェクトで指定してください。"
          : describe(cause),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="panel project-editor"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-defaults-title"
    >
      <h2 id="project-defaults-title">生成既定値</h2>
      <p className="muted">
        Recipe既定値の上にProject設定を重ね、Scene、Shot、実行時入力の順で上書きします。
      </p>
      <nav className="project-lifecycle-tabs" aria-label="生成種別">
        {KINDS.map((item) => (
          <button
            key={item.value}
            type="button"
            aria-pressed={kind === item.value}
            className={kind === item.value ? "primary" : undefined}
            onClick={() => setKind(item.value)}
          >
            {item.label}
          </button>
        ))}
      </nav>
      {!profile || !restText || !promptValues ? (
        <p className="muted">読込み中...</p>
      ) : (
        <form className="stack" onSubmit={submit}>
          <label>
            Recipe
            <select
              value={profile.recipe_id ?? ""}
              onChange={(event) => update({ recipe_id: event.target.value || null })}
            >
              <option value="">指定なし</option>
              {matchingRecipes.map((recipe) => (
                <option key={recipe.id} value={recipe.id}>{recipe.name}</option>
              ))}
            </select>
          </label>
          <p className="muted">
            Workflow: {selectedRecipe?.workflow_version_id ?? "Recipe選択後に解決"}
          </p>
          <PromptFieldsEditor
            idPrefix={`project-defaults-${kind}`}
            values={promptValues[kind]}
            onChange={changePromptField}
            onAdd={addPromptField}
            onRemove={removePromptField}
          />
          <label>
            実行入力（モデル、解像度、アスペクト比、Seedなど）
            <textarea
              className="mono"
              rows={12}
              value={restText[kind]}
              onChange={(event) =>
                setRestText({ ...restText, [kind]: event.target.value })
              }
            />
          </label>
          <label>
            キャラクター参照（1行1件）
            <textarea
              value={(profile.character_references ?? []).join("\n")}
              onChange={(event) =>
                update({
                  character_references: event.target.value
                    .split("\n")
                    .map((value) => value.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <div className="filters">
            <TextSetting label="画風" value={profile.style} onChange={(style) => update({ style })} />
            <TextSetting label="色調" value={profile.color_tone} onChange={(color_tone) => update({ color_tone })} />
            <TextSetting label="音声キャスト" value={profile.voice_cast} onChange={(voice_cast) => update({ voice_cast })} />
            <TextSetting label="BGM方針" value={profile.bgm_policy} onChange={(bgm_policy) => update({ bgm_policy })} />
            <TextSetting label="出力先" value={profile.output_directory} onChange={(output_directory) => update({ output_directory })} />
            <TextSetting label="命名規則" value={profile.filename_pattern} onChange={(filename_pattern) => update({ filename_pattern })} />
          </div>
          {result?.warnings
            .filter((warning) => warning.kind === kind)
            .map((warning) => (
              <p key={`${warning.code}-${warning.field ?? ""}`} className="error">
                {warning.message}{warning.field ? `（${warning.field}）` : ""}
              </p>
            ))}
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button type="button" disabled={busy} onClick={onCancel}>キャンセル</button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "保存中..." : "全媒体の設定を保存"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function TextSetting({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string | null;
  onChange: (value: string | null) => void;
}) {
  return (
    <label>
      {label}
      <input value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} />
    </label>
  );
}
