import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProvider, ImagePromptAssist } from "../api/client";
import { api } from "../api/client";
import { PromptAssist } from "./PromptAssist";

vi.mock("../api/client", () => ({
  api: { assistImagePrompt: vi.fn() },
}));

vi.mock("./MediaPicker", () => ({
  MediaPicker: ({ onChange }: { onChange: (value: { id: string }[]) => void }) => (
    <button type="button" onClick={() => onChange([{ id: "picked" }])}>
      画像を選ぶ
    </button>
  ),
  readPickedImage: vi.fn(async () => ({ base64: "YWJj", mediaType: "image/png" })),
}));

const PROVIDERS: AgentProvider[] = [
  {
    id: "openai" as AgentProvider["id"],
    available: true,
    is_default: true,
    label: "OpenAI",
    supports_images: true,
  },
];

const CURRENT = { positive: "tag_a", negative: "" };

const ASSIST_RESULT: ImagePromptAssist = {
  positive_prompt: "p",
  negative_prompt: "n",
  natural_text: "",
  rationale: "",
  tag_glosses: [],
  tag_line: "",
  model: null,
  provider_id: "stub",
};

function assistImagePromptMock() {
  return vi.mocked(api.assistImagePrompt);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("PromptAssist の review 分岐 (#366)", () => {
  it("画像を添えなければ、補完のみでは review が偽で伝わる", async () => {
    assistImagePromptMock().mockResolvedValue(ASSIST_RESULT);
    const onApply = vi.fn();
    render(
      <PromptAssist providers={PROVIDERS} idPrefix="t" current={CURRENT} onApply={onApply} />,
    );

    fireEvent.change(screen.getByLabelText("画像の説明"), { target: { value: "説明" } });
    fireEvent.click(screen.getByRole("button", { name: "プロンプトを補完" }));

    await screen.findByRole("button", { name: "プロンプトを補完" });
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ review: false }),
    );
  });

  it("画像を添えずレビューを選ぶと、review が真で伝わる", async () => {
    assistImagePromptMock().mockResolvedValue(ASSIST_RESULT);
    const onApply = vi.fn();
    render(
      <PromptAssist providers={PROVIDERS} idPrefix="t" current={CURRENT} onApply={onApply} />,
    );

    fireEvent.click(screen.getByLabelText("現在のプロンプトをレビューして直す"));
    fireEvent.click(screen.getByRole("button", { name: "レビューして直す" }));

    await screen.findByRole("button", { name: "レビューして直す" });
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ review: true }),
    );
  });

  it("画像を添えると、レビューを選んでいても review は偽で伝わる", async () => {
    assistImagePromptMock().mockResolvedValue(ASSIST_RESULT);
    const onApply = vi.fn();
    render(
      <PromptAssist providers={PROVIDERS} idPrefix="t" current={CURRENT} onApply={onApply} />,
    );

    fireEvent.click(screen.getByLabelText("現在のプロンプトをレビューして直す"));
    fireEvent.click(screen.getByRole("button", { name: "画像を選ぶ" }));
    fireEvent.click(screen.getByRole("button", { name: "画像を見て直す" }));

    await screen.findByRole("button", { name: "画像を見て直す" });
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ review: false }),
    );
    expect(assistImagePromptMock()).toHaveBeenCalledWith(
      expect.objectContaining({
        image: { content_base64: "YWJj", media_type: "image/png" },
      }),
    );
  });
});
