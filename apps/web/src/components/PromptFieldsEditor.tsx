import { PROMPT_FIELD_NAMES } from "../prompt/fields";
import type { PromptFieldName } from "../prompt/fields";

const PROMPT_FIELD_LABEL: Record<PromptFieldName, string> = {
  positive_prompt: "プロンプト",
  negative_prompt: "ネガティブプロンプト",
};

interface Props {
  /** 現在この入力に含まれているプロンプト欄だけを渡す。含まれない欄は表示しない。 */
  values: Partial<Record<PromptFieldName, string>>;
  onChange: (name: PromptFieldName, value: string) => void;
  /** 欄を新設する。JSONにまだその名前が無かった場合に使う。 */
  onAdd: (name: PromptFieldName) => void;
  /** 欄を取り除く。JSONからキーごと消える。 */
  onRemove: (name: PromptFieldName) => void;
  idPrefix: string;
}

/**
 * `positive_prompt`/`negative_prompt`をJSONの生テキストではなく専用のtextareaで
 * 編集させる。他の入力項目 (モデル、解像度、seedなど) はJSON側にそのまま残るため、
 * このコンポーネントはプロンプト欄の有無と値だけを扱う。
 *
 * 欄が無い入力へ空文字列を強制的に足すと、その入力を使うRecipeの
 * `input_schema`次第では互換性判定を壊しかねない。そのため追加は明示的な操作
 * (`onAdd`)を通してだけ行う。
 */
export function PromptFieldsEditor({ values, onChange, onAdd, onRemove, idPrefix }: Props) {
  const present = PROMPT_FIELD_NAMES.filter((name) => name in values);
  const missing = PROMPT_FIELD_NAMES.filter((name) => !(name in values));
  return (
    <div className="stack">
      {present.map((name) => (
        <div key={name}>
          <label htmlFor={`${idPrefix}-${name}`}>{PROMPT_FIELD_LABEL[name]}</label>
          <textarea
            id={`${idPrefix}-${name}`}
            className="mono"
            rows={4}
            value={values[name] ?? ""}
            onChange={(event) => onChange(name, event.target.value)}
          />
          <button type="button" onClick={() => onRemove(name)}>
            {PROMPT_FIELD_LABEL[name]}を削除
          </button>
        </div>
      ))}
      {missing.length > 0 && (
        <div className="row">
          {missing.map((name) => (
            <button key={name} type="button" onClick={() => onAdd(name)}>
              {PROMPT_FIELD_LABEL[name]}を追加
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
