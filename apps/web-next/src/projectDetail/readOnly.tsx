import { Fieldset, Stack } from "@mantine/core";
import { createContext, useContext, type ReactNode } from "react";

/** ゴミ箱のProjectを開いている間は`true`。APIが更新を受け付けないので、両タブの編集を止める。 */
export const ReadOnlyContext = createContext(false);

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}

/** 内側の入力とボタンをまとめて無効にする`Stack`。枠線と余白は付けない。 */
export function EditFieldset({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  return (
    <Fieldset variant="unstyled" p={0} m={0} disabled={disabled}>
      <Stack>{children}</Stack>
    </Fieldset>
  );
}
