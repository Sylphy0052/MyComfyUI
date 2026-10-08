import { useMutation } from "@tanstack/react-query";

import { apiRequest, type ImagePromptAssist, type ImagePromptAssistBody } from "../api/client";
import { notifyError } from "../notifications";

/** `POST <path>`の変換API用。失敗は赤い通知で出し、呼び出し側の入力欄には触れない。 */
export function usePromptAssist<Body, Result>(path: string, failureTitle: string) {
  return useMutation({
    mutationFn: (body: Body) => apiRequest<Result>(path, { method: "POST", body: JSON.stringify(body) }),
    onError: (error) => notifyError(failureTitle, error),
  });
}

/** `POST /image-prompt-assists`。 */
export function useImagePromptAssist(failureTitle: string) {
  return usePromptAssist<ImagePromptAssistBody, ImagePromptAssist>("/image-prompt-assists", failureTitle);
}
