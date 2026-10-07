"""TTS Backendを1回だけ実行する worker。

**各engineのvenvのPythonで動かす。** voice-runner本体のvenvには torch も
transformers も入っていない。runnerが

    <engineのpython> tts_worker.py <request.json> <response.json>

の形で起動し、終わったらプロセスごと落としてVRAMを返す。

request.json の項目は voice_runner.app が組み立てる。engine名で分岐し、選んだ
engineのライブラリだけをimportする。呼び出し仕様の出典は novel-writer の
`tools/ai-media/docs/tts-backends.md`。
"""

from __future__ import annotations

import json
import sys
import time
import wave
from pathlib import Path
from typing import Any


def set_seed(seed: int) -> None:
    """生成の直前に乱数を固定する。

    irodoriは`SamplingRequest.seed`にも同じ値を渡す。
    """
    import numpy as np
    import torch

    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    np.random.seed(seed % (2**32))


def vram_peak_mb() -> float | None:
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        return torch.cuda.max_memory_allocated() / (1024 * 1024)
    except (ImportError, RuntimeError):
        # 実測値が取れないことは生成の失敗ではない。値を欠いたまま先へ進める。
        return None


def write_wav(path: Path, samples: Any, sample_rate: int) -> None:
    """(1, N)または1次元のndarrayを16bit PCM wavとして書き出す。"""
    import numpy as np

    array = np.asarray(samples)
    if array.ndim > 1:
        array = array[0]
    array = np.clip(array.astype("float32"), -1.0, 1.0)
    pcm = (array * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as sink:
        sink.setnchannels(1)
        sink.setsampwidth(2)
        sink.setframerate(sample_rate)
        sink.writeframes(pcm.tobytes())


def run_irodori(request: dict[str, Any]) -> tuple[Any, int]:
    """Irodori-TTS。参照音声だけで声質を写すため、参照テキストは使わない。

    入力は漢字かな交じりのままでよい。`model_id`はHugging Faceのrepo idで、
    `model.safetensors`とtokenizerをHFのキャッシュへ取得してから読む。

    Irodori-TTSはvenvへパッケージとして入らないため、cloneした`home`を
    import pathへ足す。
    """
    home = request.get("home")
    if home:
        sys.path.insert(0, home)
    from irodori_tts.inference_runtime import (
        InferenceRuntime,
        RuntimeKey,
        SamplingRequest,
        download_hf_checkpoint,
    )

    runtime = InferenceRuntime.from_key(
        RuntimeKey(
            checkpoint=download_hf_checkpoint(request["model_id"]),
            model_device="cuda",
            codec_device="cuda",
        )
    )
    set_seed(int(request["seed"]))
    result = runtime.synthesize(
        SamplingRequest(
            text=request["text"],
            ref_wav=request["reference_audio"],
            seed=int(request["seed"]),
        )
    )
    wav = result.audio.detach().to(device="cpu").float().numpy()
    return wav, int(result.sample_rate)


RUNNERS = {
    "irodori": run_irodori,
}


def main() -> int:
    request_path = Path(sys.argv[1])
    response_path = Path(sys.argv[2])
    request = json.loads(request_path.read_text(encoding="utf-8"))
    engine = request["engine"]
    runner = RUNNERS.get(engine)
    if runner is None:
        response_path.write_text(
            json.dumps({"error": f"未対応のengineです: {engine}"}, ensure_ascii=False),
            encoding="utf-8",
        )
        return 1
    started = time.monotonic()
    wav, sample_rate = runner(request)
    output = Path(request["output"])
    write_wav(output, wav, sample_rate)
    with wave.open(str(output), "rb") as source:
        audio_sec = source.getnframes() / source.getframerate()
    response_path.write_text(
        json.dumps(
            {
                "sample_rate": sample_rate,
                "audio_sec": audio_sec,
                "elapsed_sec": time.monotonic() - started,
                "vram_peak_mb": vram_peak_mb(),
                "model": request.get("model_id"),
                "revision": request.get("model_revision"),
                "seed": request["seed"],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
