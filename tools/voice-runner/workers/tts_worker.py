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

    3つのengineはいずれも`seed`引数を持たない。生成直前にここを呼べば波形が再現する
    ことが`検証_tts/06_seed固定`で3engineとも確認されている。
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


def to_katakana(text: str, home: str | None) -> str:
    """CosyVoice3へ渡す前にカタカナの分かち書きへ変換する。

    変換器は`home`(novel-writer側のcosyvoiceディレクトリ)に置かれた`jp_kana.py`を
    借りる。MyComfyUI側では複製せず、ai-media側のファイルも書き換えない。
    """
    if home:
        sys.path.insert(0, home)
    from jp_kana import to_katakana as convert

    return convert(text)


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


def run_qwen3(request: dict[str, Any]) -> tuple[Any, int]:
    """Qwen3-TTS (Primary)。入力は漢字かな交じりのままでよい。"""
    import torch
    from qwen_tts import Qwen3TTSModel

    model = Qwen3TTSModel.from_pretrained(
        request["model_id"],
        device_map="cuda:0",
        dtype=torch.bfloat16,
        attn_implementation="sdpa",
    )
    set_seed(int(request["seed"]))
    wav, sample_rate = model.generate_voice_clone(
        text=request["text"],
        language="Japanese",
        ref_audio=request["reference_audio"],
        # 参照テキストに嘘を渡すと生成が破綻する (検証_minimax/18)。
        ref_text=request["reference_transcript"],
    )
    return wav, int(sample_rate)


def run_voxcpm2(request: dict[str, Any]) -> tuple[Any, int]:
    """VoxCPM2 (Secondary)。continuation modeを使う。

    `reference_wav_path`のみの方式は抑揚は写るが読みが崩れる
    (検証_tts/05: 完全一致 12/15 対 7/15)。セリフ用途では`prompt_wav_path`を使う。
    """
    from voxcpm import VoxCPM

    model = VoxCPM.from_pretrained(request["model_id"])
    sample_rate = int(model.tts_model.sample_rate)
    set_seed(int(request["seed"]))
    if request.get("mode") == "reference_wav_path":
        wav = model.generate(
            text=request["text"], reference_wav_path=request["reference_audio"]
        )
    else:
        wav = model.generate(
            text=request["text"],
            prompt_wav_path=request["reference_audio"],
            prompt_text=request["reference_transcript"],
        )
    return wav, sample_rate


def run_cosyvoice3(request: dict[str, Any]) -> tuple[Any, int]:
    """CosyVoice3 (比較用)。日本語はカタカナの分かち書きで渡す。"""
    home = request.get("katakana_home")
    if home:
        sys.path.insert(0, home)
    from cosyvoice.cli.cosyvoice import CosyVoice2
    from cosyvoice.utils.file_utils import load_wav

    model = CosyVoice2(request["model_id"])
    sample_rate = int(request.get("sample_rate") or 24000)
    prompt = load_wav(request["reference_audio"], 16000)
    text = request["text"]
    if request.get("needs_katakana"):
        text = to_katakana(text, home)
        prompt_text = to_katakana(request["reference_transcript"], home)
    else:
        prompt_text = request["reference_transcript"]
    set_seed(int(request["seed"]))
    chunks = list(model.inference_zero_shot(text, prompt_text, prompt, stream=False))
    if not chunks:
        raise RuntimeError("CosyVoice3が音声を返しませんでした。")
    return chunks[0]["tts_speech"], sample_rate


RUNNERS = {
    "qwen3-tts-clone": run_qwen3,
    "voxcpm2-prompt": run_voxcpm2,
    "cosyvoice3": run_cosyvoice3,
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
