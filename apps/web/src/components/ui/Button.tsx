import type { ButtonHTMLAttributes } from "react";

/**
 * 操作の重みを見た目で区別するボタン。
 *
 * - primary: 画面の主操作。塗りつぶしで最も目立たせる。
 * - secondary: 副操作。既定の枠付きボタン。
 * - danger: 取り消せない操作。赤で示す。
 * - ghost: 繰り返し並ぶ補助操作。枠を消して一覧の密度を上げる。
 */
export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "primary",
  secondary: "",
  danger: "danger-button",
  ghost: "ghost-button",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

export function classNames(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(" ") || undefined;
}

export function Button({
  variant = "secondary",
  type = "button",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classNames(VARIANT_CLASS[variant], className)}
      {...props}
    />
  );
}
