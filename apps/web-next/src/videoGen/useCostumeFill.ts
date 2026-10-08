import { useEffect, useRef } from "react";

import type { StoryCostume } from "../api/client";
import { reimportInputImage, useUploadInputImage } from "../imageGen/useImageGen";
import { notifyError } from "../notifications";
import { artifactIdOf } from "../projectDetail/MediaThumb";
import { notifyDroppedReferences } from "./referenceNotice";
import { mergeReferences, REFERENCES_MAX, videoImage, type VideoDraft, type VideoImage } from "./videoForm";

const INPUT_PREFIX = "input:";

type Props = {
  costume: StoryCostume | null;
  filledCostumeId: string | null;
  /** 最新の参照画像。取り込みを待った後に読むため、描画のたびに更新されるrefで受ける。 */
  referencesRef: { readonly current: readonly VideoImage[] };
  setDraft: (update: (current: VideoDraft) => VideoDraft) => void;
};

/**
 * 衣装を選ぶと、衣装の参照画像を参照の枠へ入れる。手で足した参照画像は残し、前の衣装から入れたものは置き換える。
 * アップロードした参照画像 (`input:`) はsha256を持たないため、入力cacheへ取り込み直す。
 * 取り込みに失敗した画像があれば、入れ済みの衣装として記録しない。衣装を選び直すと取り込みをやり直す。
 * `seq`は入れ直すたびに進め、取り込みを待つ間に衣装が変わったら、待っていた結果を捨てる。
 */
export function useCostumeFill({ costume, filledCostumeId, referencesRef, setDraft }: Props) {
  const upload = useUploadInputImage();
  const seq = useRef(0);
  const fillingId = useRef<string | null>(null);
  useEffect(() => {
    if (costume === null) {
      seq.current += 1;
      fillingId.current = null;
      return;
    }
    if (filledCostumeId === costume.id || fillingId.current === costume.id) return;
    const costumeId = costume.id;
    const mine = ++seq.current;
    fillingId.current = costumeId;
    let failed = false;
    const resolveKey = async (key: string): Promise<VideoImage | null> => {
      const artifactId = artifactIdOf(key);
      if (artifactId !== null) return videoImage({ artifact_id: artifactId }, "衣装の参照画像", true);
      if (!key.startsWith(INPUT_PREFIX)) {
        // 補完済みとして記録する (failedにしない)。選び直さない限り再実行されず、通知は繰り返されない。
        notifyError("衣装の参照画像の形式が未対応のため入れられませんでした", key);
        return null;
      }
      try {
        const reference = await reimportInputImage(key.slice(INPUT_PREFIX.length), upload.mutateAsync);
        return videoImage({ relative_path: reference.relative_path, sha256: reference.sha256 }, "衣装の参照画像", true);
      } catch (error) {
        failed = true;
        notifyError("衣装の参照画像を取り込めませんでした。衣装を選び直すと再試行します", error);
        return null;
      }
    };
    void (async () => {
      const keys = costume.reference_images;
      const images = (await Promise.all(keys.slice(0, REFERENCES_MAX).map(resolveKey))).flatMap((image) => image ?? []);
      if (mine !== seq.current) return;
      fillingId.current = null;
      const merged = mergeReferences(
        referencesRef.current.filter((item) => !item.auto),
        images,
      );
      notifyDroppedReferences({
        duplicated: merged.duplicated,
        overflow: merged.overflow + Math.max(0, keys.length - REFERENCES_MAX),
      });
      setDraft((current) => ({
        ...current,
        references: mergeReferences(
          current.references.filter((item) => !item.auto),
          images,
        ).references,
        filled: failed ? current.filled : { ...current.filled, costumeId },
      }));
    })();
  }, [costume, filledCostumeId, referencesRef, setDraft, upload.mutateAsync]);
}
