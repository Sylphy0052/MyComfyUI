import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PromptDiffReview } from "./PromptDiffReview";
import type { PromptDiffField } from "./PromptDiffReview";

function field(overrides: Partial<PromptDiffField>): PromptDiffField {
  return {
    key: "positive",
    label: "Prompt",
    current: "tag_a, tag_b",
    proposed: "tag_a",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("PromptDiffReview", () => {
  it("acceptRemovalsを立てた欄では削除hunkが既定で選択され、注記が付く (#366)", () => {
    render(
      <PromptDiffReview
        fields={[field({ acceptRemovals: true })]}
        onCancel={() => {}}
        onAccept={() => {}}
      />,
    );
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText("(既定で選択)")).not.toBeNull();
  });

  it("acceptRemovalsを立てない欄では削除hunkは未選択で、注記も出ない (#366)", () => {
    render(
      <PromptDiffReview
        fields={[field({ acceptRemovals: false })]}
        onCancel={() => {}}
        onAccept={() => {}}
      />,
    );
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(screen.queryByText("(既定で選択)")).toBeNull();
  });

  it("追加hunkは既定で選択されるが、削除の既定選択の注記は付かない", () => {
    render(
      <PromptDiffReview
        fields={[field({ current: "tag_a", proposed: "tag_a, tag_b", acceptRemovals: false })]}
        onCancel={() => {}}
        onAccept={() => {}}
      />,
    );
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(screen.queryByText("(既定で選択)")).toBeNull();
  });
});
