import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Recipe } from "../api/client";
import { GenerationSweepPanel } from "./GenerationSweepPanel";

vi.mock("../api/client", () => ({
  api: {
    listAgentProviders: vi.fn(async () => []),
    listLookProfiles: vi.fn(async () => []),
    listGenerationExperiments: vi.fn(async () => []),
    previewGenerationExperiment: vi.fn(),
    createGenerationExperiment: vi.fn(),
    cancelPendingExperimentJobs: vi.fn(),
    retryFailedExperimentJobs: vi.fn(),
    deleteGenerationExperiment: vi.fn(),
  },
}));

// この画面にも「前回の説明を残したまま開き直す」専用経路 (notes: null のリテラル) が無く、
// 唯一の開き直し手段は PromptAssist の再呼び出しなので、呼び出し回数で説明文を変えて
// 「開き直すたびに前回のnotesが残っていないか」を検証できるようにする。
let assistCallCount = 0;
vi.mock("./PromptAssist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./PromptAssist")>();
  return {
    ...actual,
    PromptAssist: ({
      onApply,
    }: {
      onApply: (result: {
        positive: string;
        negative: string;
        notes: { rationale: string };
        review: boolean;
      }) => void;
    }) => (
      <button
        type="button"
        onClick={() => {
          assistCallCount += 1;
          onApply({
            positive: `assisted positive ${assistCallCount}`,
            negative: "assisted negative",
            notes: { rationale: assistCallCount === 1 ? "前回の説明" : "今回の説明" },
            review: false,
          });
        }}
      >
        補完
      </button>
    ),
  };
});

function recipe(): Recipe {
  return {
    id: "recipe-1",
    name: "Recipe 1",
    engine: "comfyui",
    kind: "image",
    defaults: {},
    input_schema: {},
    workflow_template_ref: { name: "anima_img2img" },
    workflow_version_id: null,
    supersedes_recipe_id: null,
    created_at: "2024-01-01T00:00:00Z",
  };
}

function baseProps() {
  return {
    // 一覧取得の副作用は本テストの対象外なので、activeをfalseにして呼ばせない。
    active: false,
    projectId: "project-1",
    sceneId: "scene-1",
    shotId: "shot-1",
    recipes: [recipe()],
    onJobsChanged: vi.fn(),
    activeComparisonId: null,
    onCompare: vi.fn(),
    onSelectProject: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  assistCallCount = 0;
});

async function openViaAssist() {
  fireEvent.click(await screen.findByRole("button", { name: "補完" }));
  await screen.findByText("AIの説明: 前回の説明");
}

describe("GenerationSweepPanelのpromptDiff開閉 (#374)", () => {
  it("反映で閉じたあと、補完から開き直すと前回の説明が出ない", async () => {
    render(<GenerationSweepPanel {...baseProps()} />);
    await openViaAssist();

    fireEvent.click(screen.getByRole("button", { name: "選んだ差分を反映" }));
    expect(screen.queryByText(/前回の説明/)).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "補完" }));
    await screen.findByText("AIの説明: 今回の説明");
    expect(screen.queryByText(/前回の説明/)).toBeNull();
  });

  it("キャンセルで閉じたあと、補完から開き直すと前回の説明が出ない", async () => {
    render(<GenerationSweepPanel {...baseProps()} />);
    await openViaAssist();

    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByText(/前回の説明/)).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "補完" }));
    await screen.findByText("AIの説明: 今回の説明");
    expect(screen.queryByText(/前回の説明/)).toBeNull();
  });
});
