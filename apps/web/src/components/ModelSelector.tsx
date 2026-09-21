import { useEffect, useMemo, useState } from "react";

import { ApiError, api } from "../api/client";
import type { Recipe, WorkflowModelOptions } from "../api/client";

interface FieldSpec {
  label?: unknown;
  control?: unknown;
}

interface Props {
  recipe: Recipe | null;
  disabled?: boolean;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  onValidityChange: (valid: boolean) => void;
}

function describe(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  return String(error);
}

/** Workflow版が宣言したslotだけを、ComfyUI在庫から選択させる。 */
export function ModelSelector({
  recipe,
  disabled,
  values,
  onChange,
  onValidityChange,
}: Props) {
  const [inventory, setInventory] =
    useState<WorkflowModelOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modelFields = useMemo(
    () =>
      Object.entries(recipe?.input_schema ?? {}).filter(([, raw]) => {
        const field = raw as FieldSpec;
        return field?.control === "model";
      }),
    [recipe],
  );

  useEffect(() => {
    // Recipe/Project既定値をruntime入力として送り直さない。利用者がselectを変更した
    // slotだけをoverrideとして親へ渡す。
    onChange({});
  }, [recipe?.id]);

  useEffect(() => {
    const versionId = recipe?.workflow_version_id;
    if (!versionId || modelFields.length === 0) {
      setInventory(null);
      setError(null);
      return;
    }
    let active = true;
    setLoading(true);
    setInventory(null);
    setError(null);
    api
      .getWorkflowModelOptions(versionId)
      .then((result) => {
        if (!active || result.workflow_version_id !== versionId) return;
        setInventory(result);
        if (!result.backend_reachable) {
          setError(
            result.reason ?? "ComfyUIのモデル在庫を取得できません。",
          );
        }
      })
      .catch((cause) => {
        if (active) {
          setInventory(null);
          setError(describe(cause));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [recipe?.workflow_version_id, modelFields.length]);

  useEffect(() => {
    if (disabled || modelFields.length === 0) {
      onValidityChange(true);
      return;
    }
    if (loading || !inventory?.backend_reachable) {
      onValidityChange(false);
      return;
    }
    const defaults = (recipe?.defaults ?? {}) as Record<string, unknown>;
    const slots = new Map(inventory.slots.map((slot) => [slot.variable, slot]));
    onValidityChange(
      modelFields.every(([name]) => {
        const override = values[name];
        // Project、Scene、Shotの解決値はクライアントで推測しない。未変更slotは
        // preview/create APIが解決後の値をComfyUI在庫へ再照合する。
        return (
          override === undefined ||
          slots.get(name)?.options.includes(override) === true
        );
      }),
    );
  }, [disabled, inventory, loading, modelFields, recipe?.defaults, values]);

  if (modelFields.length === 0) return null;

  const slots = new Map(
    (inventory?.slots ?? []).map((slot) => [slot.variable, slot]),
  );
  const defaults = (recipe?.defaults ?? {}) as Record<string, unknown>;
  return (
    <fieldset className="stack" disabled={disabled || loading}>
      <legend>モデル</legend>
      {modelFields.map(([name, raw]) => {
        const field = raw as FieldSpec;
        const slot = slots.get(name);
        const options = slot?.options ?? [];
        const fallback = defaults[name];
        const current =
          values[name] ?? (typeof fallback === "string" ? fallback : "");
        const available = options.includes(current);
        return (
          <div key={name}>
            <label htmlFor={`model-${name}`}>
              {typeof field.label === "string" ? field.label : name}
            </label>
            <select
              id={`model-${name}`}
              value={available ? current : ""}
              disabled={disabled || loading || options.length === 0}
              onChange={(event) =>
                onChange({ ...values, [name]: event.target.value })
              }
            >
              {!available && (
                <option value="" disabled>
                  {current
                    ? `利用不可: ${current}`
                    : "利用可能なモデルを選択してください"}
                </option>
              )}
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
            {slot?.reason && <p className="muted">{slot.reason}</p>}
          </div>
        );
      })}
      <p className="muted">
        未変更のslotは送信せず、Project、Scene、Shot、Recipeの既定値を使用します。
      </p>
      {loading && <p className="muted">モデル在庫を確認中...</p>}
      {error && <p className="error">{error}</p>}
    </fieldset>
  );
}
