import { createContext, useContext } from "react";

import type { ToastTone } from "./Toast";

/**
 * 操作の結果をトーストで知らせる通知1件分。action を付けると
 * トースト上にボタンが出る (取り消しの導線、F-19)。
 *
 * group を指定すると、同じ group の古い通知を置き換える。
 * 採否を続けて変えたとき、取り消しの対象を最新の1件に絞るため。
 */
export type Notice = {
  tone: ToastTone;
  message: string;
  group?: string;
  action?: {
    label: string;
    onAction: () => Promise<void>;
  };
};

export type Notify = (notice: Notice) => void;

export const NotifyContext = createContext<Notify>(() => {});

/** App が配る通知関数を受け取る。Provider の外では何もしない。 */
export function useNotify(): Notify {
  return useContext(NotifyContext);
}
