import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api/client";
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
import { conflictNotice } from "./BackendNotice";
import { mergePrompt } from "../prompt/merge";

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

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("画像を読み込めませんでした。"));
    reader.onabort = () => reject(new Error("画像の読み込みが中断されました。"));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("画像をBase64へ変換できませんでした。"));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("画像をBase64へ変換できませんでした。"));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

interface Props {
  projectId: string | null;
  recipes: Recipe[];
  disabled: boolean;
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
}

export function GenerationForm({
  projectId,
  recipes,
  disabled,
  submitting,
  onSubmit,
  onPreview,
  previewing,
  preview,
  previewError,
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
  const [tagImage, setTagImage] = useState<File | null>(null);
  const [extractingTags, setExtractingTags] = useState(false);
  const [tagError, setTagError] = useState<string | null>(null);
  const [extractedTags, setExtractedTags] = useState<string[]>([]);
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [batchCount, setBatchCount] = useState("1");

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
  }, [recipe, allFields, defaultValues]);

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
    // 既に入力されているプロンプトは残し、補完結果をタグ順に沿って追記する。
    setValues((current) => ({
      ...current,
      positive_prompt: mergePrompt(current.positive_prompt ?? "", result.positive).prompt,
      negative_prompt: mergePrompt(current.negative_prompt ?? "", result.negative).prompt,
    }));
    setTouchedFields((current) => new Set(current).add("positive_prompt").add("negative_prompt"));
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
    if (!tagImage) return;
    if (!tagImage.type.startsWith("image/")) {
      setTagError("画像形式を判別できません。対応する画像を選び直してください。");
      return;
    }
    setExtractingTags(true);
    setTagError(null);
    try {
      const result = await api.extractImageTags(
        await toBase64(tagImage),
        tagImage.type,
      );
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
    const current = values.positive_prompt ?? "";
    // 既存のタグは並び順ごと残し、新しいタグだけをタグ順に沿って差し込む。
    const merged = mergePrompt(current, extractedTags.join(", "));
    if (merged.added === 0) return;
    setValues({
      ...values,
      positive_prompt: merged.prompt,
    });
    setTouchedFields((currentFields) =>
      new Set(currentFields).add("positive_prompt")
    );
  };

  const renderField = (field: FieldSpec) => {
    const changed = isFieldChanged(field.name);
    return (
    <div key={field.name}>
      <label htmlFor={`field-${field.name}`}>
        {field.label}
        {field.required ? " *" : ""}
        {changed && <span className="badge field-changed">既定値と異なる</span>}
      </label>
      {field.control === "textarea" ? (
        <textarea
          id={`field-${field.name}`}
          disabled={useInheritedDefaults}
          value={values[field.name] ?? ""}
          onChange={(event) => changeField(field.name, event.target.value)}
        />
      ) : (
        <input
          id={`field-${field.name}`}
          disabled={useInheritedDefaults}
          type={field.control === "number" ? "number" : "text"}
          value={values[field.name] ?? ""}
          onChange={(event) => changeField(field.name, event.target.value)}
        />
      )}
      {field.help && <p className="muted">{field.help}</p>}
      {changed && (
        <button
          type="button"
          disabled={useInheritedDefaults}
          onClick={() => resetField(field.name)}
        >
          この項目を既定値へ戻す
        </button>
      )}
      {field.name === "positive_prompt" && (
        <div className="tag-extractor">
          <label htmlFor="tag-image">画像からタグを抽出</label>
          <div className="row">
            <input
              id="tag-image"
              disabled={useInheritedDefaults || extractingTags}
              type="file"
              accept="image/*"
              onChange={(event) => {
                setTagImage(event.target.files?.[0] ?? null);
                setExtractedTags([]);
                setTagError(null);
              }}
            />
            <button
              type="button"
              disabled={useInheritedDefaults || !tagImage || extractingTags}
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
    disabled ||
    submitting ||
    previewing ||
    !modelsValid ||
    (!recipe && !useInheritedDefaults);

  return (
    <section className="panel">
      <h2>生成</h2>
      <div className="stack">
        <fieldset className="form-section">
          <legend>プロンプト</legend>
          <PromptAssist
            providers={providers}
            idPrefix="image"
            placeholder="例: 雨上がりの東京の路地を歩く黒い猫。ネオンの反射、映画的な光。"
            onApply={applyAssist}
          />
          {promptFields.map(renderField)}
        </fieldset>

        <fieldset className="form-section">
          <legend>出力設定</legend>
          <button
            type="button"
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
            <label htmlFor="recipe">プリセット</label>
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
          {!useInheritedDefaults && changedFields.length > 0 && (
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

          <ModelSelector
            recipe={recipe}
            disabled={useInheritedDefaults}
            values={modelValues}
            onChange={setModelValues}
            onValidityChange={setModelsValid}
          />

          {parameterFields.map(renderField)}
        </fieldset>

        <details className="form-section collapsible">
          <summary>ルックとバリエーション</summary>
          <div className="stack">
            <fieldset disabled={useInheritedDefaults}>
              <LookProfileManager
                kind="image"
                recipe={recipe}
                selectedIds={lookProfileIds}
                onSelectionChange={setLookProfileIds}
              />
            </fieldset>

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

        <fieldset className="form-section">
          <legend>確認と投入</legend>
          {invalid && <p className="error">{invalid}</p>}
          {disabled && <p className="muted">Shotを選ぶと投入できます。</p>}

          <ExecutionPreview
            preview={preview}
            error={previewError}
            loading={previewing}
          />
        </fieldset>
      </div>

      {/* 投入操作はフォームの長さに関わらず押せるよう、下端へ固定する。 */}
      <div className="form-actions">
        <button type="button" disabled={actionsDisabled} onClick={runPreview}>
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
        <span className="muted">バッチ {batchCount || "1"}</span>
      </div>
    </section>
  );
}
