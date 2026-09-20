import { useEffect, useMemo, useState } from "react";

import type { ApiError, GenerationPreview, Recipe } from "../api/client";
import { ExecutionPreview } from "./ExecutionPreview";

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
  recipes: Recipe[];
  disabled: boolean;
  submitting: boolean;
  onSubmit: (recipe: Recipe, inputs: Record<string, unknown>) => void;
  // 投入前の確認もAPIを直接呼ばず、Appから受け取った関数へ委ねる。
  onPreview: (recipe: Recipe, inputs: Record<string, unknown>) => void;
  previewing: boolean;
  preview: GenerationPreview | null;
  previewError: ApiError | null;
}

export function GenerationForm({
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
  const fields = useMemo(() => (recipe ? toFieldSpecs(recipe) : []), [recipe]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<string | null>(null);

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

  /** 入力の検証と`inputs`の組み立て。プレビューと投入で同じ値を使う。 */
  const buildInputs = (): Record<string, unknown> | null => {
    const inputs: Record<string, unknown> = {};
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
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed)) {
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
    if (!recipe) {
      return;
    }
    const inputs = buildInputs();
    if (!inputs) {
      return;
    }
    onSubmit(recipe, inputs);
  };

  /** 投入せずに解決済み入力とWorkflow差分だけを取る。Jobは作られない。 */
  const runPreview = () => {
    if (!recipe) {
      return;
    }
    const inputs = buildInputs();
    if (!inputs) {
      return;
    }
    onPreview(recipe, inputs);
  };

  return (
    <section className="panel">
      <h2>生成</h2>
      <div className="stack">
        <div>
          <label htmlFor="recipe">プリセット</label>
          <select
            id="recipe"
            value={recipeId}
            onChange={(event) => setRecipeId(event.target.value)}
          >
            {recipes.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>

        {fields.map((field) => (
          <div key={field.name}>
            <label htmlFor={`field-${field.name}`}>
              {field.label}
              {field.required ? " *" : ""}
            </label>
            {field.control === "textarea" ? (
              <textarea
                id={`field-${field.name}`}
                value={values[field.name] ?? ""}
                onChange={(event) =>
                  setValues({ ...values, [field.name]: event.target.value })
                }
              />
            ) : (
              <input
                id={`field-${field.name}`}
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

        {invalid && <p className="error">{invalid}</p>}
        {disabled && <p className="muted">Shotを選ぶと投入できます。</p>}

        <div className="row">
          <button
            type="button"
            disabled={disabled || submitting || previewing || !recipe}
            onClick={runPreview}
          >
            {previewing ? "確認中..." : "投入前に確認"}
          </button>
          <button
            type="button"
            className="primary"
            disabled={disabled || submitting || previewing || !recipe}
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
