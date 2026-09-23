import type { ReactNode } from "react";

import { Button, classNames } from "./Button";
import type { ButtonProps } from "./Button";
import { Tooltip } from "./Tooltip";

/**
 * アイコンだけのボタン。label をアクセシブルな名前とツールチップの両方に使い、
 * 見た目と読み上げの名前を一致させる。
 */
export function IconButton({
  icon,
  label,
  variant = "ghost",
  className,
  ...props
}: Omit<ButtonProps, "children" | "aria-label"> & {
  icon: ReactNode;
  label: string;
}) {
  return (
    <Tooltip content={label}>
      <Button
        variant={variant}
        className={classNames("icon-button", className)}
        aria-label={label}
        {...props}
      >
        {icon}
      </Button>
    </Tooltip>
  );
}
