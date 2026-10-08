import { notifications } from "@mantine/notifications";

/** 失敗を赤い通知で出す。`Error`でない値はそのまま文字列にして本文にする。 */
export function notifyError(title: string, error: unknown) {
  notifications.show({ color: "red", title, message: error instanceof Error ? error.message : String(error) });
}
