import { useState } from "react";

import { api } from "../api/client";
import type { AgentProvider, AgentProviderId } from "../api/client";
import { noticeSuffix } from "./BackendNotice";
import { MediaPicker, readPickedImage } from "./MediaPicker";
import type { PickedMedia } from "./MediaPicker";

interface Props {
  /** 選択肢として出す AI プロバイダ。取得は呼び出し元が行う。 */
  providers: AgentProvider[];
  /** 説明欄と補完ボタンに付ける id の接頭辞。同一画面での重複を避ける。 */
  idPrefix: string;
  placeholder?: string;
  /** 画像を添付したときに、AI が直す土台として渡す現在の prompt と negative。 */
  current: { positive: string; negative: string };
  /** 画像欄で生成物・登録素材を選ぶときの絞り込みに使う。 */
  projectId?: string | null;
  /** 補完結果の反映。呼び出し元の prompt と negative へ入れる。 */
  onApply: (result: { positive: string; negative: string }) => void;
}

/**
 * 日本語の説明から positive prompt と negative prompt を AI に補完させる入力欄。
 * 画像を添えると、画像と現在の prompt を突き合わせて直した案を返す。
 */
export function PromptAssist({
  providers,
  idPrefix,
  placeholder,
  current,
  projectId,
  onApply,
}: Props) {
  const [description, setDescription] = useState("");
  const [providerId, setProviderId] = useState<AgentProviderId | "">("");
  const [images, setImages] = useState<PickedMedia[]>([]);
  const [assisting, setAssisting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const withImage = images.length > 0;
  const selectedProvider = providers.find((provider) => provider.id === providerId);
  // 既定のAIが画像に対応するかは画面から分からない。非対応ならAPIが理由を返す。
  const imageUnsupported = withImage && selectedProvider?.supports_images === false;

  const assist = async () => {
    if (!description.trim()) {
      setError(withImage ? "直したい点を入力してください。" : "画像の説明を入力してください。");
      return;
    }
    if (imageUnsupported) return;
    setAssisting(true);
    setError(null);
    try {
      const image = withImage ? await readPickedImage(images[0]) : null;
      const result = await api.assistImagePrompt({
        instruction: description,
        provider_id: providerId || null,
        ...(image && {
          image: { content_base64: image.base64, media_type: image.mediaType },
          current_positive_prompt: current.positive,
          current_negative_prompt: current.negative,
        }),
      });
      onApply({ positive: result.positive_prompt, negative: result.negative_prompt });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setAssisting(false);
    }
  };

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-description`}>
          {withImage ? "直したい点" : "画像の説明"}
        </label>
        <textarea
          id={`${idPrefix}-description`}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder={withImage ? "例: 髪がはねすぎ。もっと引いた構図に。" : placeholder}
        />
        <p className="muted">
          {withImage
            ? "画像と現在のPromptを見比べて、AIが直したPromptとNegativeを差分で示します。"
            : "日本語で説明するとAIがPromptとNegativeを補完します。"}
        </p>
      </div>
      <MediaPicker
        kind="image"
        label="見せる画像 (任意)"
        value={images}
        onChange={(next) => {
          setImages(next);
          setError(null);
        }}
        multiple={false}
        disabled={assisting}
        projectId={projectId}
        autoRegister={false}
      />
      <div className="row">
        <label htmlFor={`${idPrefix}-provider`}>AI</label>
        <select
          id={`${idPrefix}-provider`}
          value={providerId}
          onChange={(event) => setProviderId(event.target.value as AgentProviderId | "")}
        >
          <option value="">既定のAI</option>
          {providers.map((provider) => (
            <option
              key={provider.id}
              value={provider.id}
              disabled={!provider.available || (withImage && !provider.supports_images)}
            >
              {provider.label}{provider.available ? "" : " (利用不可)"}
              {withImage && !provider.supports_images ? " (画像非対応)" : ""}
              {noticeSuffix(provider)}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={assisting || imageUnsupported}
          onClick={() => void assist()}
        >
          {assisting ? "補完中..." : withImage ? "画像を見て直す" : "Promptを補完"}
        </button>
      </div>
      {imageUnsupported && (
        <p className="error">
          {selectedProvider?.label}は画像の入力に対応していません。画像に対応するAIを選んでください。
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
