import type { HTMLAttributes } from "react";

import { classNames } from "./Button";

type CardElement = "div" | "section" | "article" | "figure" | "li";

/** 一覧の1項目を面として区切る入れ物。 */
export function Card({
  as: Tag = "div",
  className,
  ...props
}: HTMLAttributes<HTMLElement> & { as?: CardElement }) {
  return <Tag className={classNames("card", className)} {...props} />;
}
