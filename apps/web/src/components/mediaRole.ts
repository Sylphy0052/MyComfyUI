import type { MediaRole } from "../api/client";

/** 役割タグの表示名。取込・選択・一覧の各画面で同じ語を使う。 */
export const MEDIA_ROLE_LABEL: Record<MediaRole, string> = {
  appearance_reference: "外見参照",
  pose: "ポーズ",
  background: "背景",
  costume: "衣装",
  other: "その他",
};
export const MEDIA_ROLE_OPTIONS = Object.keys(MEDIA_ROLE_LABEL) as MediaRole[];
