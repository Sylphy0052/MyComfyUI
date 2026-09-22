import { useEffect, useMemo, useState } from "react";

import { api } from "../api/client";
import type {
  AgentProvider,
  AgentProviderId,
  ApiError,
  GenerationPreview,
  Recipe,
} from "../api/client";
import { ExecutionPreview } from "./ExecutionPreview";
import { ModelSelector } from "./ModelSelector";
import { LookProfileManager } from "./LookProfileManager";

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
  const fields = useMemo(
    () =>
      recipe
        ? toFieldSpecs(recipe).filter((field) => field.control !== "model")
        : [],
    [recipe],
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
  const [description, setDescription] = useState("");
  const [providers, setProviders] = useState<AgentProvider[]>([]);
  const [providerId, setProviderId] = useState<AgentProviderId | "">("");
  const [assisting, setAssisting] = useState(false);
  const [assistError, setAssistError] = useState<string | null>(null);
  const [batchCount, setBatchCount] = useState("1");

  useEffect(() => {
    if (!recipeId && recipes.length > 0) {
      setRecipeId(recipes[0].id);
    }
  }, [recipes, recipeId]);

  useEffect(() => {
    if (recipe) {
      setValues(initialValues(recipe, toFieldSpecs(recipe)));
      setTouchedFields(new Set());
    }
  }, [recipe]);

  useEffect(() => {
    void api.listAgentProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

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

  const assist = async () => {
    if (!description.trim()) {
      setAssistError("画像の説明を入力してください。");
      return;
    }
    setAssisting(true);
    setAssistError(null);
    try {
      const result = await api.assistImagePrompt({
        instruction: description,
        provider_id: providerId || null,
      });
      setValues((current) => ({
        ...current,
        positive_prompt: result.positive_prompt,
        negative_prompt: result.negative_prompt,
      }));
      setTouchedFields((current) => new Set(current).add("positive_prompt").add("negative_prompt"));
    } catch (cause) {
      setAssistError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssisting(false);
    }
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
    const current = values.positive_prompt?.trim() ?? "";
    const existing = new Set(
      current
        .split(",")
        .map((tag) => tag.trim().toLocaleLowerCase())
        .filter(Boolean),
    );
    const tagsToAdd: string[] = [];
    for (const tag of extractedTags) {
      const normalized = tag.toLocaleLowerCase();
      if (existing.has(normalized)) continue;
      existing.add(normalized);
      tagsToAdd.push(tag);
    }
    const suffix = tagsToAdd.join(", ");
    if (!suffix) return;
    setValues({
      ...values,
      positive_prompt: current ? `${current}, ${suffix}` : suffix,
    });
    setTouchedFields((currentFields) =>
      new Set(currentFields).add("positive_prompt")
    );
  };

  const renderField = (field: FieldSpec) => (
    <div key={field.name}>
      <label htmlFor={`field-${field.name}`}>
        {field.label}
        {field.required ? " *" : ""}
      </label>
      {field.control === "textarea" ? (
        <textarea
          id={`field-${field.name}`}
          disabled={useInheritedDefaults}
          value={values[field.name] ?? ""}
          onChange={(event) => {
            setValues({ ...values, [field.name]: event.target.value });
            setTouchedFields((current) => new Set(current).add(field.name));
          }}
        />
      ) : (
        <input
          id={`field-${field.name}`}
          disabled={useInheritedDefaults}
          type={field.control === "number" ? "number" : "text"}
          value={values[field.name] ?? ""}
          onChange={(event) => {
            setValues({ ...values, [field.name]: event.target.value });
            setTouchedFields((current) => new Set(current).add(field.name));
          }}
        />
      )}
      {field.help && <p className="muted">{field.help}</p>}
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
          <p className="muted">選んだ画像は設定済みのQwen互換AIへ送信して解析します。</p>
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
          <div>
            <label htmlFor="image-description">画像の説明</label>
            <textarea
              id="image-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="例: 雨上がりの東京の路地を歩く黒い猫。ネオンの反射、映画的な光。"
            />
            <p className="muted">日本語で説明するとAIがPromptとNegativeを補完します。</p>
          </div>
          <div className="row">
            <label htmlFor="prompt-provider">AI</label>
            <select
              id="prompt-provider"
              value={providerId}
              onChange={(event) =>
                setProviderId(event.target.value as AgentProviderId | "")
              }
            >
              <option value="">既定のAI</option>
              {providers.map((provider) => (
                <option
                  key={provider.id}
                  value={provider.id}
                  disabled={!provider.available}
                >
                  {provider.label}{provider.available ? "" : " (利用不可)"}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={assisting}
              onClick={() => void assist()}
            >
              {assisting ? "補完中..." : "Promptを補完"}
            </button>
          </div>
          {assistError && <p className="error">{assistError}</p>}
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
