"""実行中Jobの進捗と最新プレビュー画像を持つ、非永続のストア。

値はBackendの監視から届いたものを最後の1件だけ持ち、DBへは保存しない。API再起動や
Job終了で消えてよい。状態の正本は引き続きDBのJobであり、ここは表示用の補助情報に
限る。
"""

from dataclasses import dataclass, replace

from mycomfyui_api.events import job_events


@dataclass(frozen=True)
class JobProgress:
    value: int = 0
    max: int = 0
    node: str | None = None
    preview: bytes | None = None
    preview_media_type: str | None = None
    #: プレビューを受け取るたびに1増える。0はまだ受け取っていないことを表す。
    preview_seq: int = 0


class JobProgressStore:
    def __init__(self) -> None:
        self._entries: dict[str, JobProgress] = {}

    def get(self, job_id: str) -> JobProgress | None:
        return self._entries.get(job_id)

    def update_progress(
        self, job_id: str, *, value: int, maximum: int, node: str | None
    ) -> None:
        current = self._entries.get(job_id, JobProgress())
        self._store(job_id, replace(current, value=value, max=maximum, node=node))

    def update_preview(self, job_id: str, *, data: bytes, media_type: str) -> None:
        current = self._entries.get(job_id, JobProgress())
        self._store(
            job_id,
            replace(
                current,
                preview=data,
                preview_media_type=media_type,
                preview_seq=current.preview_seq + 1,
            ),
        )

    def clear(self, job_id: str) -> None:
        self._entries.pop(job_id, None)

    def _store(self, job_id: str, entry: JobProgress) -> None:
        self._entries[job_id] = entry
        job_events.publish_progress(
            job_id,
            value=entry.value,
            maximum=entry.max,
            node=entry.node,
            preview_seq=entry.preview_seq,
        )


job_progress = JobProgressStore()
