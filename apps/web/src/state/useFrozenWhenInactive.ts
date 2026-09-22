import { useState } from "react";

/**
 * 隠れているViewへ渡す値を、表示に戻るまで凍結する。
 *
 * 入力を失わせないために全Viewを常時マウントしたままにすると、Scene/Shotを
 * 切り替えるたびに、見えていないViewまで一覧を取り直しに行く。表示中のViewだけが
 * 最新の値を受け取り、隠れているViewは表示へ戻った時点で追いつくようにする。
 *
 * 保持にrefではなくstateを使うのは、レンダー中にrefを書き換えると、破棄された
 * レンダーの値が残って画面と食い違う余地があるため。レンダー中のstate更新は
 * 同じコンポーネントを描き直すだけで、コミットされた値だけが残る。
 */
export function useFrozenWhenInactive<T>(value: T, active: boolean): T {
  const [frozen, setFrozen] = useState(value);
  if (active && !Object.is(frozen, value)) setFrozen(value);
  return active ? value : frozen;
}
