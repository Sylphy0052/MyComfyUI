"""生成音声をWhisperで書き起こす worker。

**ASR用venvのPythonで動かす。** runnerが

    <asrのpython> asr_worker.py <request.json> <response.json>

の形で起動する。既存環境へは何も書き込まない。処理は novel-writer の
`tools/ai-media/tools/asr/transcribe.py` と同じで、16kHzモノラルへ落としてから
`automatic-speech-recognition` へ渡す。
"""

from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

TARGET_SR = 16000


def load_16k(path: Path):
    """wavを16kHzのモノラルへ落とす。

    整数比でのみデシメートする。簡易ローパスをかけてから間引く。
    """
    import numpy as np
    import soundfile as sf

    samples, rate = sf.read(path)
    if samples.ndim > 1:
        samples = samples.mean(1)
    if rate % TARGET_SR == 0 and rate > TARGET_SR:
        step = rate // TARGET_SR
        samples = np.convolve(samples, np.ones(step) / step, mode="same")[::step]
    elif rate != TARGET_SR:
        # 整数比でないときは線形補間する。
        count = int(len(samples) * TARGET_SR / rate)
        samples = np.interp(
            np.linspace(0, len(samples) - 1, count),
            np.arange(len(samples)),
            samples,
        )
    return samples.astype("float32")


def main() -> int:
    request_path = Path(sys.argv[1])
    response_path = Path(sys.argv[2])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    audio_path = Path(request["audio"])

    import torch
    from transformers import pipeline

    asr = pipeline(
        "automatic-speech-recognition",
        model=request["model_id"],
        torch_dtype=torch.float16,
        device="cuda:0",
    )
    audio = load_16k(audio_path)
    result = asr(
        {"raw": audio, "sampling_rate": TARGET_SR},
        generate_kwargs={
            "language": request.get("language", "ja"),
            "task": "transcribe",
        },
    )
    with wave.open(str(audio_path), "rb") as source:
        duration_sec = source.getnframes() / source.getframerate()
    response_path.write_text(
        json.dumps(
            {
                "text": str(result["text"]).strip(),
                "duration_sec": duration_sec,
                "model": request["model_id"],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
