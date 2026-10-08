import { notifications } from "@mantine/notifications";

import { REFERENCES_MAX, type MergedReferences } from "./videoForm";

/** 参照画像を足したときに入れなかった分があれば、黙って捨てずに知らせる。 */
export function notifyDroppedReferences({ duplicated, overflow }: Pick<MergedReferences, "duplicated" | "overflow">) {
  const parts = [
    overflow > 0 ? `上限${REFERENCES_MAX}枚を超えた${overflow}枚` : null,
    duplicated > 0 ? `同じ画像がある${duplicated}枚` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return;
  notifications.show({ color: "yellow", message: `参照画像に入れませんでした: ${parts.join("、")}` });
}
