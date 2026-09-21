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

/** Recipe の `input_schema` の 1 項目。表示用の項目は任意とする。 */
interface FieldSpec {
  name: string;
  type: string;
  required: boolean;
  label: string;
  control: string;
  help: string | null;
}

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
  ) => void;
  // 投入前の確認もAPIを直接呼ばず、Appから受け取った関数へ委ねる。
  onPreview: (
    recipe: Recipe | null,
    inputs: Record<string, unknown>,
    useInheritedDefaults: boolean,
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
  const [values, setValues] = useState<Record<string, string>>({});
  const [modelValues, setModelValues] = useState<Record<string, string>>({});
  const [modelsValid, setModelsValid] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  const [useInheritedDefaults, setUseInheritedDefaults] = useState(false);
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
    }
  }, [recipe]);

  useEffect(() => {
    void api.listAgentProviders().then(setProviders).catch(() => setProviders([]));
  }, []);

  /** 入力の検証と`inputs`の組み立て。プレビューと投入で同じ値を使う。 */
  const buildInputs = (): Record<string, unknown> | null => {
    const inputs: Record<string, unknown> = { ...modelValues };
    for (const field of fields) {
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
      onSubmit(null, {}, true, parsedBatchCount);
      return;
    }
    if (!recipe) {
      return;
    }
    const inputs = buildInputs();
    if (!inputs) {
      return;
    }
    onSubmit(recipe, inputs, false, parsedBatchCount);
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
    } catch (cause) {
      setAssistError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssisting(false);
    }
  };

  /** 投入せずに解決済み入力とWorkflow差分だけを取る。Jobは作られない。 */
  const runPreview = () => {
    if (useInheritedDefaults) {
      onPreview(null, {}, true);
      return;
    }
    if (!recipe) {
      return;
    }
    const inputs = buildInputs();
    if (!inputs) {
      return;
    }
    onPreview(recipe, inputs, false);
  };

  return (
    <section className="panel">
      <h2>生成</h2>
      <div className="stack">
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

        {fields.map((field) => (
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
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.target.value })
                }
              />
            ) : (
              <input
                id={`field-${field.name}`}
                disabled={useInheritedDefaults}
                type={field.control === "number" ? "number" : "text"}
                value={values[field.name] ?? ""}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.target.value })
                }
              />
            )}
            {field.help && <p className="muted">{field.help}</p>}
          </div>
        ))}

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

        {invalid && <p className="error">{invalid}</p>}
        {disabled && <p className="muted">Shotを選ぶと投入できます。</p>}

        <div className="row">
          <button
            type="button"
            disabled={
              disabled ||
              submitting ||
              previewing ||
              !modelsValid ||
              (!recipe && !useInheritedDefaults)
            }
            onClick={runPreview}
          >
            {previewing ? "確認中..." : "投入前に確認"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={
              disabled ||
              submitting ||
              previewing ||
              !modelsValid ||
              (!recipe && !useInheritedDefaults)
            }
            onClick={submit}
          >
            {submitting ? "投入中..." : "画像生成を投入"}
          </button>
        </div>

        <ExecutionPreview
          preview={preview}
          error={previewError}
          loading={previewing}
        />
      </div>
    </section>
  );
}
