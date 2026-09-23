import { classNames } from "./Button";

export interface ToggleGroupOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  /** 読み上げ用のグループ名。見た目の見出しを持たない場所に置くため必須にする。 */
  label: string;
  options: readonly ToggleGroupOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

/** 候補から1つを選ぶ `aria-pressed` ボタンの並び。表示形式の切替などに使う。 */
export function ToggleGroup<T extends string>({ label, options, value, onChange, className }: Props<T>) {
  return (
    <div className={classNames("toggle-group", className)} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
