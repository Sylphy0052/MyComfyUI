import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GenerationManifest, ProjectCharacterProfile, Recipe } from "../api/client";
import { GenerationForm } from "./GenerationForm";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    api: {
      listAgentProviders: vi.fn(async () => []),
      extractImageTags: vi.fn(async () => ({ tags: ["extracted_tag"] })),
      listLookProfiles: vi.fn(async () => []),
    },
  };
});

vi.mock("./MediaPicker", () => ({
  MediaPicker: ({ onChange }: { onChange: (value: { id: string; source: unknown }[]) => void }) => (
    <button
      type="button"
      onClick={() => onChange([{ id: "picked", source: { artifact_id: "picked" } }])}
    >
      画像を選ぶ
    </button>
  ),
  readPickedImage: vi.fn(async () => ({ base64: "YWJj", mediaType: "image/png" })),
}));

// PromptAssistの内部実装 (補完API呼び出し) はPromptAssist.test.tsxで別に検証済み。
// ここでは onApply({ positive, negative, notes, review }) を呼ぶボタンへ差し替え、
// 差分state (PromptDiffState) の開閉が呼び出し元 (GenerationForm) 側で正しいかだけを見る。
vi.mock("./PromptAssist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./PromptAssist")>();
  return {
    ...actual,
    PromptAssist: ({
      onApply,
    }: Pick<ComponentProps<typeof actual.PromptAssist>, "onApply">) => (
      <button
        type="button"
        onClick={() =>
          onApply({
            positive: "assisted positive",
            negative: "assisted negative",
            notes: { rationale: "前回の説明" },
            review: false,
          })
        }
      >
        補完
      </button>
    ),
  };
});

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "recipe-1",
    name: "Recipe 1",
    engine: "comfyui",
    kind: "image",
    defaults: { positive_prompt: "", negative_prompt: "" },
    input_schema: {
      positive_prompt: { type: "string", control: "textarea", label: "プロンプト" },
      negative_prompt: { type: "string", control: "textarea", label: "ネガティブプロンプト" },
    },
    workflow_template_ref: {},
    workflow_version_id: null,
    supersedes_recipe_id: null,
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function character(overrides: Partial<ProjectCharacterProfile> = {}): ProjectCharacterProfile {
  return {
    id: "char-1",
    name: "キャラA",
    outfits: [{ id: "outfit-1", name: "衣装1", prompt: "outfit_tag", tags: [] }],
    ...overrides,
  };
}

function manifest(overrides: Partial<GenerationManifest> = {}): GenerationManifest {
  return {
    created_at: "2024-01-01T00:00:00Z",
    engine: "comfyui",
    engine_version: null,
    id: "manifest-1",
    input_refs: [],
    job_id: "job-1",
    model: {},
    parameters: {},
    replay_of_manifest_id: null,
    resolved_prompt: "restored prompt",
    seed: 1,
    workflow_artifact_id: "wf-1",
    ...overrides,
  };
}

function baseProps(overrides: Partial<Parameters<typeof GenerationForm>[0]> = {}) {
  return {
    projectId: "project-1",
    recipes: [recipe(), recipe({ id: "recipe-2", name: "Recipe 2" })],
    submitting: false,
    onSubmit: vi.fn(),
    onPreview: vi.fn(),
    previewing: false,
    preview: null,
    previewError: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.sessionStorage.clear();
});

async function openViaAssist() {
  fireEvent.click(screen.getByRole("button", { name: "補完" }));
  await screen.findByText("AIの説明: 前回の説明");
}

async function reopenViaExtractedTags() {
  fireEvent.click(screen.getByRole("button", { name: "画像を選ぶ" }));
  fireEvent.click(await screen.findByRole("button", { name: "タグを抽出" }));
  fireEvent.click(await screen.findByRole("button", { name: "プロンプトへ追加" }));
}

async function reopenViaOutfitCandidate() {
  fireEvent.change(screen.getByLabelText("キャラクター"), { target: { value: "char-1" } });
  fireEvent.click(await screen.findByRole("button", { name: "衣装1" }));
}

describe("GenerationFormのpromptDiff開閉 (#374)", () => {
  it("Recipe切替で閉じたあと、抽出タグから開き直すと前回の説明が出ない", async () => {
    render(<GenerationForm {...baseProps()} />);
    await openViaAssist();

    fireEvent.change(screen.getByLabelText("ベース (Recipe)"), {
      target: { value: "recipe-2" },
    });
    expect(screen.queryByText(/前回の説明/)).toBeNull();

    await reopenViaExtractedTags();
    expect(await screen.findByRole("button", { name: "選んだ差分を反映" })).not.toBeNull();
    expect(screen.queryByText(/前回の説明/)).toBeNull();
    expect(screen.queryByText(/AIの説明/)).toBeNull();
  });

  it("反映で閉じたあと、衣装候補から開き直すと前回の説明が出ない", async () => {
    render(<GenerationForm {...baseProps({ characters: [character()] })} />);
    await openViaAssist();

    fireEvent.click(screen.getByRole("button", { name: "選んだ差分を反映" }));
    expect(screen.queryByText(/前回の説明/)).toBeNull();

    await reopenViaOutfitCandidate();
    expect(await screen.findByRole("button", { name: "選んだ差分を反映" })).not.toBeNull();
    expect(screen.queryByText(/前回の説明/)).toBeNull();
    expect(screen.queryByText(/AIの説明/)).toBeNull();
  });

  it("キャンセルで閉じたあと、抽出タグから開き直すと前回の説明が出ない", async () => {
    render(<GenerationForm {...baseProps()} />);
    await openViaAssist();

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByText(/前回の説明/)).toBeNull();

    await reopenViaExtractedTags();
    expect(await screen.findByRole("button", { name: "選んだ差分を反映" })).not.toBeNull();
    expect(screen.queryByText(/前回の説明/)).toBeNull();
    expect(screen.queryByText(/AIの説明/)).toBeNull();
  });

  it("Look Profile復元で閉じたあと、衣装候補から開き直すと前回の説明が出ない", async () => {
    const props = baseProps({ characters: [character()] });
    const { rerender } = render(<GenerationForm {...props} />);
    await openViaAssist();

    rerender(
      <GenerationForm
        {...props}
        restore={{
          key: "restore-1",
          recipeId: null,
          recipeLineage: [],
          manifest: manifest(),
          scope: "prompt",
        }}
      />,
    );
    expect(screen.queryByText(/前回の説明/)).toBeNull();

    await reopenViaOutfitCandidate();
    expect(await screen.findByRole("button", { name: "選んだ差分を反映" })).not.toBeNull();
    expect(screen.queryByText(/前回の説明/)).toBeNull();
    expect(screen.queryByText(/AIの説明/)).toBeNull();
  });
});
