import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentProvider, ImagePromptAssist } from "../api/client";
import { api } from "../api/client";
import { PromptAssist } from "./PromptAssist";

vi.mock("../api/client", () => ({
  api: { assistImagePrompt: vi.fn() },
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
  it("補完のみでは review が偽で伝わる", async () => {
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

  it("レビューを選ぶと、review が真で伝わる", async () => {
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

  it("プロンプトが無いままレビューを選ぶと、APIを呼ばずエラーを表示する", async () => {
    assistImagePromptMock().mockResolvedValue(ASSIST_RESULT);
    const onApply = vi.fn();
    render(
      <PromptAssist
        providers={PROVIDERS}
        idPrefix="t"
        current={{ positive: "", negative: "" }}
        onApply={onApply}
      />,
    );

    fireEvent.click(screen.getByLabelText("現在のプロンプトをレビューして直す"));
    fireEvent.click(screen.getByRole("button", { name: "レビューして直す" }));

    await screen.findByText(
      "レビューするプロンプトがありません。先にプロンプトを入力してください。",
    );
    expect(assistImagePromptMock()).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("レビューの方向が上限文字数を超えると、APIを呼ばずエラーを表示する", async () => {
    assistImagePromptMock().mockResolvedValue(ASSIST_RESULT);
    const onApply = vi.fn();
    render(
      <PromptAssist providers={PROVIDERS} idPrefix="t" current={CURRENT} onApply={onApply} />,
    );

    fireEvent.click(screen.getByLabelText("現在のプロンプトをレビューして直す"));
    const textarea = screen.getByLabelText("レビューの方向 (任意)") as HTMLTextAreaElement;
    const overLength = "a".repeat(Number(textarea.maxLength) + 1);
    fireEvent.change(textarea, { target: { value: overLength } });
    fireEvent.click(screen.getByRole("button", { name: "レビューして直す" }));

    await screen.findByText(/文字以内にしてください。$/);
    expect(assistImagePromptMock()).not.toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it("APIが失敗すると、その理由をエラーとして表示する", async () => {
    assistImagePromptMock().mockRejectedValue(new Error("APIエラーです"));
    const onApply = vi.fn();
    render(
      <PromptAssist providers={PROVIDERS} idPrefix="t" current={CURRENT} onApply={onApply} />,
    );

    fireEvent.change(screen.getByLabelText("画像の説明"), { target: { value: "説明" } });
    fireEvent.click(screen.getByRole("button", { name: "プロンプトを補完" }));

    await screen.findByText("APIエラーです");
    expect(onApply).not.toHaveBeenCalled();
  });
});
