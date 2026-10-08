import { Button, Group, Modal, Text } from "@mantine/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useBlocker } from "react-router";

type UnsavedGuard = {
  setDirty: (key: string, dirty: boolean) => void;
  /**
   * 未保存の編集があれば確認を出し、了承されてから`action`を実行する。無ければすぐ実行する。
   * `scope`を渡すと、そのキーの編集だけを見る (衣装ドロワーを閉じるときに、背後の編集を巻き込まないため)。
   */
  runGuarded: (action: () => void, scope?: string) => void;
};

const GuardContext = createContext<UnsavedGuard | null>(null);

function useGuard(): UnsavedGuard {
  const guard = useContext(GuardContext);
  if (!guard) throw new Error("UnsavedGuardProviderの内側で使ってください");
  return guard;
}

export function useRunGuarded(): UnsavedGuard["runGuarded"] {
  return useGuard().runGuarded;
}

/** 編集欄が自分の未保存状態を知らせる。外れる (unmount) と未保存ではなくなる。 */
export function useReportDirty(key: string, dirty: boolean) {
  const { setDirty } = useGuard();
  useEffect(() => {
    setDirty(key, dirty);
    return () => setDirty(key, false);
  }, [key, dirty, setDirty]);
}

/**
 * 未保存の編集がある間、次の3つで確認を出す。
 * - アプリ内の画面移動 (React Routerの`useBlocker`)
 * - ブラウザのタブを閉じる・再読み込み (`beforeunload`)
 * - 画面内の選択・タブの切り替え (`runGuarded`)
 */
export function UnsavedGuardProvider({ children }: { children: ReactNode }) {
  const [dirtyKeys, setDirtyKeys] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState<(() => void) | null>(null);
  const isDirty = dirtyKeys.size > 0;

  const setDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((previous) => {
      if (previous.has(key) === dirty) return previous;
      const next = new Set(previous);
      if (dirty) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const runGuarded = useCallback(
    (action: () => void, scope?: string) => {
      if (scope === undefined ? isDirty : dirtyKeys.has(scope)) setPending(() => action);
      else action();
    },
    [isDirty, dirtyKeys],
  );

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      isDirty &&
      (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
  );

  // 確認の最中に保存などで未保存でなくなったら、止めていた移動をそのまま通す。
  useEffect(() => {
    if (blocker.state === "blocked" && !isDirty) blocker.proceed();
  }, [blocker, isDirty]);

  useEffect(() => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 古いブラウザは`returnValue`の代入を確認ダイアログの条件にする。
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  const opened = blocker.state === "blocked" || pending !== null;
  const keepEditing = () => {
    if (blocker.state === "blocked") blocker.reset();
    setPending(null);
  };
  const discard = () => {
    if (blocker.state === "blocked") blocker.proceed();
    pending?.();
    setPending(null);
  };

  return (
    <GuardContext.Provider value={{ setDirty, runGuarded }}>
      {children}
      {/* 衣装ドロワー (z-index 200) の上に出す。同じ値だと先に開いたドロワーの下に隠れ、押せなくなる。 */}
      <Modal opened={opened} onClose={keepEditing} title="未保存の変更があります" centered zIndex={300}>
        <Text size="sm">保存していない変更は、移動すると失われます。</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={keepEditing}>
            編集を続ける
          </Button>
          <Button color="red" onClick={discard}>
            破棄して移動
          </Button>
        </Group>
      </Modal>
    </GuardContext.Provider>
  );
}
