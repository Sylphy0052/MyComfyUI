import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api/client";
import { mergePrompt } from "../prompt/merge";
import { planPresetBlocker, type PlanPreset } from "../state/productionPlan";
import { ignoresShortcut } from "./ui/shortcuts";
import type {
  AgentProvider,
  ApiError,
  GenerationPreview,
  Recipe,
} from "../api/client";
import { ExecutionPreview } from "./ExecutionPreview";
import { ModelSelector } from "./ModelSelector";
import { LookProfileManager } from "./LookProfileManager";
import { PromptAssist } from "./PromptAssist";
import { PlanPresetNote } from "./ProductionPlanPanel";
import { PromptDiffReview } from "./PromptDiffReview";
import type { PromptDiffField } from "./PromptDiffReview";
import { conflictNotice } from "./BackendNotice";
import { MediaPicker, readPickedImage } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";

/** Recipe の `input_schema` の 1 項目。表示用の項目は任意とする。 */
interface FieldSpec {
  name: string;
  type: string;
  required: boolean;
  label: string;
  control: string;
  help: string | null;
}

const PROMPT_FIELD_NAMES = new Set(["positive_prompt", "negative_prompt"]);

function toFieldSpecs(recipe: Recipe): FieldSpec[] {
  return Object.entries(recipe.input_schema).map(([name, raw]) => {
    const spec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const type = typeof spec.type === "string" ? spec.type : "string";
    return {
      name,
      type,
      required: spec.required === true,
      label: typeof spec.label === "string" ? spec.label : name,
      control:
        typeof spec.control === "string"
          ? spec.control
          : type === "string"
            ? "text"
            : "number",
      help: typeof spec.help === "string" ? spec.help : null,
    };
  });
}

/** 入力文字列がその項目の型として送信できるか。Recipe切替時の持ち越し判定に使う。 */
function isParsableAs(field: FieldSpec, raw: string): boolean {
  if (raw.trim() === "") {
    return true;
  }
  if (field.type === "integer") {
    return Number.isInteger(Number(raw));
  }
  if (field.type === "number") {
    return Number.isFinite(Number.parseFloat(raw));
  }
  return true;
}

function initialValues(recipe: Recipe, fields: FieldSpec[]): Record<string, string> {
  const defaults = recipe.defaults as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = defaults[field.name];
    values[field.name] =
      value === undefined || value === null ? "" : String(value);
  }
  return values;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface Props {
  projectId: string | null;
  recipes: Recipe[];
  submitting: boolean;
  onSubmit: (
    recipe: Recipe | null,
    inputs: Record<string, unknown>,
    useInheritedDefaults: boolean,
    batchCount: number,
    lookProfileIds: string[],
  ) => void;
  // 投入前の確認もAPIを直接呼ばず、Appから受け取った関数へ委ねる。
  onPreview: (
    recipe: Recipe | null,
    inputs: Record<string, unknown>,
    useInheritedDefaults: boolean,
    lookProfileIds: string[],
  ) => void;
  previewing: boolean;
  preview: GenerationPreview | null;
  previewError: ApiError | null;
  /**
   * 作品制作 (モードB) 向けの表示。Presetとプロンプトと投入だけを出す。
   * 隠した項目もマウントしたままにし、ラボへ移ったとき同じ入力で続けられるようにする。
   */
  simple?: boolean;
  /** モードBで生成フォームが見えている間だけtrue。Gキーで投入する。 */
  shortcutActive?: boolean;
  /**
   * 作品制作の計画で開始済みのとき、この工程へ入れるPresetとプロンプト。
   * `scope` (Shotと工程) とPresetの組ごとに1回だけ入れ、その後の使用者の変更は上書きしない。
   */
  plan?: { scope: string; preset: PlanPreset | null; prompt: string } | null;
}

export function GenerationForm({
  projectId,
  recipes,
  submitting,
  onSubmit,
  onPreview,
  previewing,
  preview,
  previewError,
  simple = false,
  shortcutActive = false,
  plan = null,
}: Props) {
  const [recipeId, setRecipeId] = useState<string>("");
  const recipe = useMemo(
    () => recipes.find((item) => item.id === recipeId) ?? null,
    [recipes, recipeId],
  );
  // モデル選択を含む全項目。既定値の組み立てと、持ち越し時の型の確認に使う。
  const allFields = useMemo(() => (recipe ? toFieldSpecs(recipe) : []), [recipe]);
  const fields = useMemo(
    () => allFields.filter((field) => field.control !== "model"),
    [allFields],
  );
  // Prompt系はプロンプトのセクション、残りは出力設定のセクションへ振り分ける。
  const promptFields = useMemo(
    () => fields.filter((field) => PROMPT_FIELD_NAMES.has(field.name)),
    [fields],
  );
  const parameterFields = useMemo(
    () => fields.filter((field) => !PROMPT_FIELD_NAMES.has(field.name)),
    [fields],
  );
  // Recipe の既定値。現在の入力との差分表示と、既定値への書き戻しに使う。
  const defaultValues = useMemo(
    () => (recipe ? initialValues(recipe, allFields) : {}),
    [recipe, allFields],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [modelValues, setModelValues] = useState<Record<string, string>>({});
  const [modelsValid, setModelsValid] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [useInheritedDefaults, setUseInheritedDefaults] = useState(false);
  const [lookProfileIds, setLookProfileIds] = useState<string[]>([]);
  const [touchedFields, setTouchedFields] = useState<Set<string>>(new Set());
  const [tagMedia, setTagMedia] = useState<PickedMedia[]>([]);
  const [extractingTags, setExtractingTags] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [extractedTags, setExtractedTags] = useState<string[]>([]);
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [batchCount, setBatchCount] = useState("1");
  const [promptDiff, setPromptDiff] = useState<PromptDiffField[] | null>(null);

  useEffect(() => {
    if (!recipeId && recipes.length > 0) {
      setRecipeId(recipes[0].id);
    }
  }, [recipes, recipeId]);

  // Recipe変更の効果から参照する。描画中に代入して、effectの実行順に依存しないようにする。
  const touchedRef = useRef(touchedFields);
  touchedRef.current = touchedFields;
  const valuesRef = useRef(values);
  valuesRef.current = values;

  // Recipeを変えても、使用者が触った項目の入力は残す。触っていない項目だけ新しい既定値にする。
  // 触った印は現在のRecipeに合わせて作り直す。残したままだと、Look Profileを使うときに
  // 前のRecipeで触っただけの項目がProfileの値を上書きしてしまう。
  useEffect(() => {
    if (!recipe) return;
    const specs = new Map(allFields.map((field) => [field.name, field]));
    const nextValues = { ...defaultValues };
    const nextTouched = new Set<string>();
    for (const name of touchedRef.current) {
      const spec = specs.get(name);
      const kept = valuesRef.current[name];
      // 新しいRecipeに無い項目、型が合わず送信時に弾かれる値は持ち越さない。
      if (!spec || kept === undefined || !isParsableAs(spec, kept)) continue;
      nextValues[name] = kept;
      if (kept !== (defaultValues[name] ?? "")) {
        nextTouched.add(name);
      }
    }
    setValues(nextValues);
    setTouchedFields(nextTouched);
    // 開いている差分レビューは切替前の値を比べているので閉じる。
    setPromptDiff(null);
  }, [recipe, allFields, defaultValues]);

  // 計画のPresetとプロンプトを入れる。値は触った印を付け、上のRecipe変更の効果で持ち越させる。
  const appliedPlanRef = useRef<string | null>(null);
  // 計画が最後に入れたプロンプト。使用者が書き換えていなければ、工程を移ったときに入れ替える。
  const planPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (!plan || recipes.length === 0) return;
    const preset = plan.preset;
    const key = `${plan.scope}:${preset?.profile.id ?? ""}`;
    if (appliedPlanRef.current === key) return;
    appliedPlanRef.current = key;
    const filled: Record<string, string> = {};
    if (preset) {
      setUseInheritedDefaults(false);
      setLookProfileIds([preset.profile.id]);
      const recipeIdOfPreset = preset.profile.recipe_id;
      if (recipeIdOfPreset && recipes.some((item) => item.id === recipeIdOfPreset)) {
        setRecipeId(recipeIdOfPreset);
      }
      for (const [name, value] of Object.entries(preset.choiceValues)) {
        if (value.trim() !== "") filled[name] = value;
      }
    }
    const currentPrompt = valuesRef.current.positive_prompt ?? "";
    if (plan.prompt && (!currentPrompt.trim() || currentPrompt === planPromptRef.current)) {
      filled.positive_prompt = plan.prompt;
      planPromptRef.current = plan.prompt;
    }
    if (Object.keys(filled).length === 0) return;
    setValues((current) => ({ ...current, ...filled }));
    setTouchedFields((current) => new Set([...current, ...Object.keys(filled)]));
  }, [plan, recipes]);

  useEffect(() => {
    void api.listAgentProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  /** 入力がRecipe既定値と異なるか。バッジと差分一覧で同じ判定を使う。 */
  const isFieldChanged = (name: string) =>
    (values[name] ?? "") !== (defaultValues[name] ?? "");

  // 既定値と異なる項目。差分の明示と、既定値で上書きするかの判断に使う。
  const changedFields = fields.filter((field) => isFieldChanged(field.name));

  /** 入力を書き換える。既定値と同じ値に戻したときは触った印も外す。 */
  const changeField = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
    setTouchedFields((current) => {
      const next = new Set(current);
      if (value === (defaultValues[name] ?? "")) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  /** 1項目だけRecipe既定値へ戻す。以降はその項目を未変更として扱う。 */
  const resetField = (name: string) => {
    setValues((current) => ({ ...current, [name]: defaultValues[name] ?? "" }));
    setTouchedFields((current) => {
      const next = new Set(current);
      next.delete(name);
      return next;
    });
  };

  /** 入力をすべてRecipe既定値で上書きする。 */
  const resetAllFields = () => {
    setValues({ ...defaultValues });
    setTouchedFields(new Set());
  };

  // タグの整理は Provider を選ばずに走るため、副作用を抽出ボタンのそばへ出す。
  const tagNotice = conflictNotice(providers);

  /** 入力の検証と`inputs`の組み立て。プレビューと投入で同じ値を使う。 */
  const buildInputs = (): Record<string, unknown> | null => {
    const inputs: Record<string, unknown> = { ...modelValues };
    for (const field of fields) {
      if (lookProfileIds.length > 0 && !touchedFields.has(field.name)) {
        continue;
      }
      const raw = values[field.name] ?? "";
      if (raw.trim() === "") {
        if (field.required) {
          setInvalid(`${field.label}は必須です。`);
          return null;
        }
        // 未入力は送らず、Recipe の既定値を使う。
        continue;
      }
      if (field.type === "integer") {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed)) {
          setInvalid(`${field.label}は整数で入力してください。`);
          return null;
        }
        inputs[field.name] = parsed;
      } else if (field.type === "number") {
        const parsed = Number.parseFloat(raw);
        if (!Number.isFinite(parsed)) {
          setInvalid(`${field.label}は数値で入力してください。`);
          return null;
        }
        inputs[field.name] = parsed;
      } else {
        inputs[field.name] = raw;
      }
    }
    setInvalid(null);
    return inputs;
  };

  const submit = () => {
    const parsedBatchCount = Number(batchCount);
    if (!Number.isInteger(parsedBatchCount) || parsedBatchCount < 1 || parsedBatchCount > 20) {
      setInvalid("バッチ数は1以上20以下の整数で入力してください。");
      return;
    }
    if (useInheritedDefaults) {
      onSubmit(null, {}, true, parsedBatchCount, []);
      return;
    }
    if (!recipe) {
      return;
    }
    const inputs = buildInputs();
    if (!inputs) {
      return;
    }
    onSubmit(recipe, inputs, false, parsedBatchCount, lookProfileIds);
  };

  const applyAssist = (result: { positive: string; negative: string }) => {
    // 既存のプロンプトをすぐ上書きせず、差分レビューを開いて採否を選ばせる。
    setPromptDiff([
      {
        key: "positive_prompt",
        label: "プロンプト",
        current: values.positive_prompt ?? "",
        proposed: result.positive,
      },
      {
        key: "negative_prompt",
        label: "ネガティブプロンプト",
        current: values.negative_prompt ?? "",
        proposed: result.negative,
      },
    ]);
  };

  const applyPromptDiffResult = (result: Record<string, string>) => {
    setValues((current) => ({ ...current, ...result }));
    setTouchedFields((current) => {
      const next = new Set(current);
      Object.keys(result).forEach((name) => next.add(name));
      return next;
    });
    setPromptDiff(null);
  };

  /** 投入せずに解決済み入力とWorkflow差分だけを取る。Jobは作られない。 */
  const runPreview = () => {
    if (useInheritedDefaults) {
      onPreview(null, {}, true, []);
      return;
    }
    if (!recipe) {
      return;
    }
    const inputs = buildInputs();
    if (!inputs) {
      return;
    }
    onPreview(recipe, inputs, false, lookProfileIds);
  };

  const extractTags = async () => {
    const item = tagMedia[0];
    if (!item) return;
    setExtractingTags(true);
    setTagError(null);
    try {
      const { base64, mediaType } = await readPickedImage(item);
      const result = await api.extractImageTags(base64, mediaType);
      setExtractedTags(result.tags);
    } catch (error) {
      setExtractedTags([]);
      setTagError(describe(error));
    } finally {
      setExtractingTags(false);
    }
  };

  const appendTags = () => {
    if (extractedTags.length === 0) return;
    // 抽出したタグに本当に新規のものが無ければ、差分レビューを開かず終える。
    const merged = mergePrompt(values.positive_prompt ?? "", extractedTags.join(", "));
    if (merged.added === 0) return;
    // 既存のタグは残したまま、抽出したタグとの差分レビューを開いて採否を選ばせる。
    setPromptDiff([
      {
        key: "positive_prompt",
        label: "プロンプト",
        current: values.positive_prompt ?? "",
        proposed: extractedTags.join(", "),
      },
    ]);
  };

  const renderField = (field: FieldSpec) => {
    const changed = isFieldChanged(field.name);
    // モードBではネガティブや出力設定はPresetの固定部分として扱い、画面に出さない。
    const fieldHidden = simple && field.name !== "positive_prompt";
    const extrasHidden = simple;
    // 差分レビュー中に書き換えると、反映したときに書いた分が黙って消える。
    const readOnly = promptDiff !== null && PROMPT_FIELD_NAMES.has(field.name);
    return (
    <div key={field.name} hidden={fieldHidden}>
      <label htmlFor={`field-${field.name}`}>
        {field.label}
        {field.required ? " *" : ""}
        {changed && <span className="badge field-changed">既定値と異なる</span>}
      </label>
      {field.control === "textarea" ? (
        <textarea
          id={`field-${field.name}`}
          disabled={useInheritedDefaults}
          readOnly={readOnly}
          value={values[field.name] ?? ""}
          onChange={(event) => changeField(field.name, event.target.value)}
        />
      ) : (
        <input
          id={`field-${field.name}`}
          disabled={useInheritedDefaults}
          type={field.control === "number" ? "number" : "text"}
          readOnly={readOnly}
          value={values[field.name] ?? ""}
          onChange={(event) => changeField(field.name, event.target.value)}
        />
      )}
      {field.help && <p className="muted">{field.help}</p>}
      {changed && !extrasHidden && (
        <button
          type="button"
          disabled={useInheritedDefaults}
          onClick={() => resetField(field.name)}
        >
          この項目を既定値へ戻す
        </button>
      )}
      {field.name === "positive_prompt" && !extrasHidden && (
        <div className="tag-extractor">
          <MediaPicker
            kind="image"
            label="画像からタグを抽出"
            value={tagMedia}
            onChange={(next) => {
              setTagMedia(next);
              setExtractedTags([]);
              setTagError(null);
            }}
            multiple={false}
            disabled={useInheritedDefaults || extractingTags}
            projectId={projectId}
          />
          <div className="row">
            <button
              type="button"
              disabled={useInheritedDefaults || tagMedia.length === 0 || extractingTags}
              onClick={extractTags}
            >
              {extractingTags ? "抽出中..." : "タグを抽出"}
            </button>
          </div>
          <p className="muted">
            選んだ画像はComfyUIのWD14 Taggerへ送信して解析します。抽出したタグの整理には
            設定済みのQwen互換AIを使います。
          </p>
          {tagNotice && <p className="muted">{tagNotice}</p>}
          {tagError && <p className="error">{tagError}</p>}
          {extractedTags.length > 0 && (
            <div className="row">
              <p className="tag-list">{extractedTags.join(", ")}</p>
              <button type="button" disabled={useInheritedDefaults} onClick={appendTags}>
                プロンプトへ追加
              </button>
            </div>
          )}
        </div>
      )}
    </div>
    );
  };

  // 投入操作はfieldsetの外にあるため、無効化はfieldsetのdisabled継承ではなくここで判断する。
  const actionsDisabled =
    submitting ||
    previewing ||
    !modelsValid ||
    (!recipe && !useInheritedDefaults);

  useEffect(() => {
    if (!shortcutActive || actionsDisabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "g" || ignoresShortcut(event)) return;
      event.preventDefault();
      submit();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [shortcutActive, actionsDisabled, submit]);

  return (
    <section className="panel">
      <h2>生成</h2>
      <div className="stack">
        <fieldset className="form-section">
          <legend>プロンプト</legend>
          <div hidden={simple}>
            {promptDiff ? (
              <PromptDiffReview
                fields={promptDiff}
                onCancel={() => setPromptDiff(null)}
                onAccept={applyPromptDiffResult}
              />
            ) : (
              <PromptAssist
                providers={providers}
                idPrefix="image"
                recipeId={recipeId}
                current={{
                  positive: values.positive_prompt ?? "",
                  negative: values.negative_prompt ?? "",
                }}
                projectId={projectId}
                placeholder="例: 雨上がりの東京の路地を歩く黒い猫。ネオンの反射、映画的な光。"
                onApply={applyAssist}
              />
            )}
          </div>
          {promptFields.map(renderField)}
        </fieldset>

        {/* 生成に効くPreset (Project既定値・ベースのRecipe・重ねるPreset) をこの節1つに集める。 */}
        <fieldset className="form-section">
          <legend>Preset</legend>
          <button
            type="button"
            hidden={simple}
            disabled={!projectId}
            aria-pressed={useInheritedDefaults}
            className={useInheritedDefaults ? "primary" : undefined}
            onClick={() => setUseInheritedDefaults((value) => !value)}
          >
            {useInheritedDefaults ? "Project既定値を使用中" : "Project既定値へ戻す"}
          </button>
          {useInheritedDefaults && (
            <p className="muted">Project、Scene、Shotの設定だけで生成します。</p>
          )}
          <div>
            <label htmlFor="recipe">ベース (Recipe)</label>
            <select
              id="recipe"
              value={recipeId}
              disabled={useInheritedDefaults}
              onChange={(event) => setRecipeId(event.target.value)}
            >
              {recipes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          {plan?.preset && (
            <PlanPresetNote
              preset={plan.preset}
              blocker={
                planPresetBlocker(plan.preset, recipe, useInheritedDefaults) ??
                (lookProfileIds.includes(plan.preset.profile.id) ? null : "計画のPresetは適用を解除されています。")
              }
            />
          )}
          {simple && recipe && !useInheritedDefaults && !modelsValid && (
            <p className="muted">
              このPresetはモデルの指定が揃っていません。ラボで確認してください。
            </p>
          )}

          {/* Presetの一覧・作成・編集・適用。作成と編集はラボだけで行う。 */}
          <div hidden={simple}>
            <fieldset disabled={useInheritedDefaults}>
              <LookProfileManager
                kind="image"
                recipe={recipe}
                selectedIds={lookProfileIds}
                onSelectionChange={setLookProfileIds}
              />
            </fieldset>
          </div>
        </fieldset>

        <fieldset className="form-section" hidden={simple}>
          <legend>出力設定</legend>
          {!simple && !useInheritedDefaults && changedFields.length > 0 && (
            <div className="recipe-diff">
              <p className="muted">
                Recipe既定値と異なる項目: {changedFields.map((field) => field.label).join(", ")}
              </p>
              <button
                type="button"
                disabled={useInheritedDefaults}
                onClick={resetAllFields}
              >
                モデル以外の入力をRecipe既定値で上書き
              </button>
            </div>
          )}

          {/* 投入可否の判定に使うため、モードBでも隠してマウントしたままにする。 */}
          <div hidden={simple}>
            <ModelSelector
              recipe={recipe}
              disabled={useInheritedDefaults}
              values={modelValues}
              onChange={setModelValues}
              onValidityChange={setModelsValid}
            />
          </div>
          {parameterFields.map(renderField)}
        </fieldset>

        <details className="form-section collapsible" hidden={simple}>
          <summary>バリエーション</summary>
          <div className="stack">
            <div>
              <label htmlFor="batch-count">バッチ数</label>
              <input
                id="batch-count"
                type="number"
                min="1"
                max="20"
                value={batchCount}
                onChange={(event) => setBatchCount(event.target.value)}
              />
              <p className="muted">バッチサイズ×バッチ数が合計生成枚数です。</p>
            </div>
          </div>
        </details>

        <fieldset className="form-section" hidden={simple}>
          <legend>確認と投入</legend>
          {invalid && <p className="error">{invalid}</p>}

          <ExecutionPreview
            preview={preview}
            error={previewError}
            loading={previewing}
          />
        </fieldset>
      </div>

      {/* 投入操作はフォームの長さに関わらず押せるよう、下端へ固定する。 */}
      <div className="form-actions">
        {simple && invalid && <p className="error">{invalid}</p>}
        <button
          type="button"
          hidden={simple}
          disabled={actionsDisabled}
          onClick={runPreview}
        >
          {previewing ? "確認中..." : "投入前に確認"}
        </button>
        <button
          type="button"
          className="primary"
          disabled={actionsDisabled}
          onClick={submit}
        >
          {submitting ? "投入中..." : "画像生成を投入"}
        </button>
        {!simple && <span className="muted">バッチ {batchCount || "1"}</span>}
      </div>
    </section>
  );
}
