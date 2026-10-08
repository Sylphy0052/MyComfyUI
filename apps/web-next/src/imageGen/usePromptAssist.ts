import { useMutation } from "@tanstack/react-query";

import { apiRequest, type ImagePromptAssist, type ImagePromptAssistBody } from "../api/client";
import { notifyError } from "../notifications";

/** `POST /image-prompt-assists`。失敗は赤い通知で出し、呼び出し側の入力欄には触れない。 */
export function useImagePromptAssist(failureTitle: string) {
  return useMutation({
    mutationFn: (body: ImagePromptAssistBody) =>
      apiRequest<ImagePromptAssist>("/image-prompt-assists", { method: "POST", body: JSON.stringify(body) }),
    onError: (error) => notifyError(failureTitle, error),
  });
}
