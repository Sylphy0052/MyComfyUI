/** 出力設定の高密度表示に使う部品 (#319)。生成フォームと派生パネルで共有する。 */

export interface SliderSpec {
  min: number;
  max: number;
  step: number;
  /** 数値入力側の上限。スライダーより広く取りたい項目 (幅・高さ) だけ指定する。 */
  inputMax?: number;
}

/**
 * スライダーを付ける項目。`input_schema`には範囲の情報が無いため、項目名で引く。
 * 幅と高さのスライダーは実用域の2048までで、数値入力は従来どおり8192まで入れられる。
 */
export const SLIDER_SPECS: Record<string, SliderSpec> = {
  steps: { min: 1, max: 100, step: 1, inputMax: 10000 },
  cfg: { min: 0, max: 20, step: 0.5, inputMax: 100 },
  width: { min: 64, max: 2048, step: 8, inputMax: 8192 },
  height: { min: 64, max: 2048, step: 8, inputMax: 8192 },
  denoise: { min: 0, max: 1, step: 0.01 },
};

interface NumberSliderProps {
  id: string;
  value: string;
  spec: SliderSpec;
  disabled?: boolean;
  readOnly?: boolean;
  onChange: (next: string) => void;
}

/** スライダーと数値入力を並べる。どちらを動かしても同じ値を共有する。 */
export function NumberSlider({ id, value, spec, disabled, readOnly, onChange }: NumberSliderProps) {
  const parsed = Number.parseFloat(value);
  const sliderValue = Number.isFinite(parsed)
    ? Math.min(spec.max, Math.max(spec.min, parsed))
    : spec.min;
  return (
    <div className="number-slider">
      <input
        type="range"
        aria-label={`${id}のスライダー`}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={sliderValue}
        disabled={disabled || readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
      <input
        id={id}
        type="number"
        min={spec.min}
        max={spec.inputMax ?? spec.max}
        step={spec.step}
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

interface SeedButtonsProps {
  /** 直前に完了したJobのseed。無いときは「前回」を押せない。 */
  lastSeed: number | null;
  disabled?: boolean;
  onChange: (next: string) => void;
}

/** seedの隣に置く「ランダム」(-1で自動採番) と「前回」(直前に完了したJobのseed) のボタン。 */
export function SeedButtons({ lastSeed, disabled, onChange }: SeedButtonsProps) {
  return (
    <>
      <button type="button" disabled={disabled} onClick={() => onChange("-1")}>
        ランダム
      </button>
      <button
        type="button"
        disabled={disabled || lastSeed === null}
        title={lastSeed === null ? "完了したJobがありません" : `直前のJobのseed: ${lastSeed}`}
        onClick={() => lastSeed !== null && onChange(String(lastSeed))}
      >
        前回
      </button>
    </>
  );
}

interface SwapButtonProps {
  disabled?: boolean;
  onClick: () => void;
}

/** 幅と高さの間に置く入れ替えボタン。 */
export function SwapButton({ disabled, onClick }: SwapButtonProps) {
  return (
    <button
      type="button"
      className="swap-dimensions"
      aria-label="幅と高さを入れ替える"
      title="幅と高さを入れ替える"
      disabled={disabled}
      onClick={onClick}
    >
      ⇄
    </button>
  );
}
