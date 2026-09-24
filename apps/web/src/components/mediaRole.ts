import type { MediaRole } from "../api/client";

/** 役割タグの表示名。取込・選択・一覧の各画面で同じ語を使う。 */
export const MEDIA_ROLE_LABEL: Record<MediaRole, string> = {
  appearance_reference: "外見参照",
  pose: "ポーズ",
  background: "背景",
  costume: "衣装",
  voice_reference: "声質参照",
  guide_audio: "ガイド音声",
  other: "その他",
};
export const MEDIA_ROLE_OPTIONS = Object.keys(MEDIA_ROLE_LABEL) as MediaRole[];

/**
 * 画像・音声それぞれに付けられる役割。`other`は両方で使う。
 * API側は種別に合わない役割を422で弾く (`AUDIO_MEDIA_ROLES`)。
 */
export const MEDIA_ROLE_OPTIONS_BY_KIND: Record<"image" | "audio", MediaRole[]> = {
  image: ["appearance_reference", "pose", "background", "costume", "other"],
  audio: ["voice_reference", "guide_audio", "other"],
};
