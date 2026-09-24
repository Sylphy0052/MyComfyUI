import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Artifact } from "../../api/client";
import { CandidateGallery } from "../CandidateGallery";
import { ToastHost } from "./ToastRegion";
import type { ToastItem } from "./ToastRegion";

const TOASTS: ToastItem[] = [{ id: "t1", tone: "success", message: "保存した" }];

// App.tsxと同じく、CandidateGalleryが通知した<dialog>をToastHostの表示先へ渡す。
// この配線自体はAppと別に再実装しているため、App側の配線漏れは検出できない。
// 検証するのはToastHostの切替と、CandidateGalleryの通知 (開閉・0件でのアンマウント) まで。
function Harness({ candidates }: { candidates: { artifact: Artifact; jobId: string }[] }) {
  const [dialogEl, setDialogEl] = useState<HTMLDialogElement | null>(null);
  return (
    <>
      <CandidateGallery
        candidates={candidates}
        busyArtifactId={null}
        onDecide={() => {}}
        active
        onDialogOpenChange={setDialogEl}
      />
      <ToastHost dialogEl={dialogEl} toasts={TOASTS} onDismiss={() => {}} onNavigate={() => {}} />
    </>
  );
}

function candidate(id: string) {
  return { artifact: { id, kind: "image", decision: "undecided", sha256: "0".repeat(64) } as unknown as Artifact, jobId: `job-${id}` };
}

function toastRegion(): HTMLElement {
  return screen.getByText("保存した").closest(".toast-region") as HTMLElement;
}

beforeEach(() => {
  // 候補の詳細取得は本テストの対象外。常に失敗させて詳細表示だけ空にする。
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ToastHost", () => {
  it("dialogElが無ければ通常のDOMへ描画する", () => {
    render(<ToastHost dialogEl={null} toasts={TOASTS} onDismiss={() => {}} onNavigate={() => {}} />);
    expect(toastRegion().closest("dialog")).toBeNull();
  });

  it("全画面比較を開いている間は開いた<dialog>の子として描画し、閉じると通常のDOMへ戻る", () => {
    render(<Harness candidates={[candidate("a"), candidate("b")]} />);
    expect(toastRegion().closest("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "全画面A/B" }));
    const dialog = toastRegion().closest("dialog");
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute("aria-label")).toBe("候補の全画面A/B比較");

    fireEvent.click(screen.getAllByRole("button", { name: "全画面を閉じる" })[0]);
    expect(toastRegion().closest("dialog")).toBeNull();
  });

  it("全画面のまま候補が0件になり<dialog>がアンマウントされたら通常のDOMへ戻る", () => {
    const { rerender } = render(<Harness candidates={[candidate("a"), candidate("b")]} />);
    fireEvent.click(screen.getByRole("button", { name: "全画面A/B" }));
    expect(toastRegion().closest("dialog")).not.toBeNull();

    rerender(<Harness candidates={[]} />);
    const region = toastRegion();
    expect(region.closest("dialog")).toBeNull();
    expect(region.isConnected).toBe(true);
  });
});
