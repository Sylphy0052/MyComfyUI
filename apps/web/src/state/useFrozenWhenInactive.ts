import { useRef } from "react";

/**
 * 隠れているViewへ渡す値を、表示に戻るまで凍結する。
 *
 * 入力を失わせないために全Viewを常時マウントしたままにすると、Scene/Shotを
 * 切り替えるたびに、見えていないViewまで一覧を取り直しに行く。表示中のViewだけが
 * 最新の値を受け取り、隠れているViewは表示へ戻った時点で追いつくようにする。
 */
export function useFrozenWhenInactive<T>(value: T, active: boolean): T {
  const frozen = useRef(value);
  if (active) frozen.current = value;
  return frozen.current;
}
