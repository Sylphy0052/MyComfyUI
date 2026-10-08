import { useState } from "react";

/**
 * 一覧で選んだID。`visibleIds`は今表示している一覧のID。
 * 一覧から消えたID (ゴミ箱へ移した・復元した・取り直しで外れた) は選択に数えず、操作の対象にもしない。
 */
export function useSelection(visibleIds: string[]) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const visible = new Set(visibleIds);
  const prune = (ids: Iterable<string>) => new Set([...ids].filter((id) => visible.has(id)));
  const selected: ReadonlySet<string> = prune(picked);

  return {
    selected,
    toggle: (id: string) =>
      setPicked((current) => {
        const next = prune(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    selectAll: () => setPicked(new Set(visibleIds)),
    clear: () => setPicked(new Set()),
    /** 選択を`ids`だけに絞る。一部だけ失敗したとき、失敗した分を選んだまま残すのに使う。 */
    keepOnly: (ids: string[]) => setPicked(prune(ids)),
    /** `ids`を選択から外す。 */
    remove: (ids: string[]) =>
      setPicked((current) => {
        const next = prune(current);
        for (const id of ids) next.delete(id);
        return next;
      }),
  };
}
