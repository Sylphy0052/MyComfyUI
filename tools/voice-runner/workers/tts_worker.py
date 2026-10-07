"""TTS Backendを1回だけ実行する worker。

**各engineのvenvのPythonで動かす。** voice-runner本体のvenvには torch も
transformers も入っていない。runnerが

    <engineのpython> tts_worker.py <request.json> <response.json>

の形で起動し、終わったらプロセスごと落としてVRAMを返す。

request.json の項目は voice_runner.app が組み立てる。engine名で分岐し、選んだ
engineのライブラリだけをimportする。
"""

from __future__ import annotations

import json
import sys
import time
import wave
from pathlib import Path
from typing import Any


def set_seed(seed: int) -> None:
    """生成の直前に乱数を固定する。irodoriは`SamplingRequest.seed`にも同じ値を渡す。"""
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


class PinnedFetchError(RuntimeError):
    """固定revisionでのモデル取得に失敗した。設定の見直しを促す文面を持つ。"""


def run_irodori(request: dict[str, Any]) -> tuple[Any, int]:
    """Irodori-TTS。参照音声とcaption (声質の文章指定) で声を作り、参照テキストは使わない。

    参照が無ければ`no_ref=True`でcaptionだけから作る。参照とcaptionが両方あれば両方を渡す。

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

    revision = request.get("model_revision")
    if revision:
        # download_hf_checkpointはrevisionを受けないため、同じ取得内容を固定revisionで行う。
        from huggingface_hub import snapshot_download

        try:
            snapshot_dir = Path(
                snapshot_download(
                    repo_id=request["model_id"],
                    revision=revision,
                    allow_patterns=["model.safetensors", "tokenizer/*"],
                )
            )
        except Exception as error:
            raise PinnedFetchError(
                f"モデルを取得できませんでした: repo={request['model_id']} "
                f"revision={revision}。engines.yamlのmodel_revisionを見直してください。"
                f" ({type(error).__name__}: {error})"
            ) from error
        checkpoint = str(snapshot_dir / "model.safetensors")
    else:
        checkpoint = download_hf_checkpoint(request["model_id"])
    key_args: dict[str, Any] = {}
    codec_repo = request.get("codec_repo")
    if codec_repo:
        codec_revision = request.get("codec_revision")
        if codec_revision:
            # コーデックはrepo idだと最新を取得するため、固定revisionで取得した
            # weights.pthのパスを渡す (codec.pyはローカルパスをそのまま読む)。
            from huggingface_hub import hf_hub_download

            try:
                codec_repo = hf_hub_download(
                    repo_id=codec_repo, filename="weights.pth", revision=codec_revision
                )
            except Exception as error:
                raise PinnedFetchError(
                    f"コーデックを取得できませんでした: repo={codec_repo} "
                    f"revision={codec_revision}。engines.yamlのcodec_revisionを見直してください。"
                    f" ({type(error).__name__}: {error})"
                ) from error
        key_args["codec_repo"] = codec_repo
    runtime = InferenceRuntime.from_key(
        RuntimeKey(
            checkpoint=checkpoint,
            model_device="cuda",
            codec_device="cuda",
            **key_args,
        )
    )
    reference = request.get("reference_audio")
    set_seed(int(request["seed"]))
    result = runtime.synthesize(
        SamplingRequest(
            text=request["text"],
            ref_wav=reference,
            no_ref=reference is None,
            caption=request.get("caption"),
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
    try:
        wav, sample_rate = runner(request)
    except PinnedFetchError as error:
        # process.pyはexit codeが0以外のときstderrを呼び出し側へ返す。
        print(str(error), file=sys.stderr)
        response_path.write_text(
            json.dumps({"error": str(error)}, ensure_ascii=False), encoding="utf-8"
        )
        return 1
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
