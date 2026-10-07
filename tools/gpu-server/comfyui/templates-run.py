"""g18のComfyUI (127.0.0.1:18188) へMyComfyUIのテンプレートを1回ずつ投入し、結果を出す。

g18上のコンテナ内で実行する。TEMPLATES_DIRにテンプレートのJSONを置き、ComfyUIのinput/をINPUT_DIRに
マウントしておく。画像・音声の入力だけ差し替え、ほかはテンプレートの既定値で流す。
"""

import json
import math
import os
import struct
import sys
import time
import urllib.request
import uuid
import wave

BASE = os.environ.get("COMFY", "http://127.0.0.1:18188")
INPUT_DIR = os.environ.get("INPUT_DIR", "/input")
TEMPLATES_DIR = os.environ.get("TEMPLATES_DIR", "templates")
# 1本あたりの完了待ちの上限(秒)。実測の最長はminimax_h3_ref2vの172s (README参照)。モデルの
# 初回ロードや動画の長尺化を見込んで約5倍の900sを既定とする。伸ばすときは環境変数で上書きする。
WAIT_TIMEOUT = float(os.environ.get("WAIT_TIMEOUT", "900"))
IMAGE = "example.png"
AUDIO = "g18_test_tone.wav"
ORDER = sys.argv[1:] or [
    "wd14_tagger",
    "image_upscale",
    "sd15_controlnet",
    "anima_txt2img",
    "anima_img2img",
    "anima_inpaint",
    "anima_ref_siglip",
    "anima_ref_incontext",
    "ace_step_bgm",
    "minimax_h3_i2v",
    "minimax_h3_ref2v",
]


def write_tone(path: str, seconds: float = 5.0, rate: int = 44100) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(
            b"".join(
                struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate)))
                for i in range(int(seconds * rate))
            )
        )


def call(path: str, body: dict | None = None) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        BASE + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        return {"http_error": e.code, "body": e.read().decode()[:2000]}


def patch_inputs(workflow: dict) -> None:
    for node in workflow.values():
        inputs = node.get("inputs", {})
        if node["class_type"] in ("LoadImage", "LoadImageMask"):
            inputs["image"] = IMAGE
        elif node["class_type"] == "LoadAudio":
            inputs["audio"] = AUDIO


def wait_history(pid: str, timeout: float = WAIT_TIMEOUT) -> dict | None:
    """履歴が完了(またはerror)になるまで待つ。timeout秒を超えたらNoneを返す。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        time.sleep(3)
        hist = call(f"/history/{pid}").get(pid)
        if not hist:
            continue
        status = hist.get("status", {})
        if status.get("completed") or status.get("status_str") == "error":
            return hist
    return None


def output_names(hist: dict) -> list[str]:
    names = []
    for out in hist.get("outputs", {}).values():
        for val in out.values():
            if not isinstance(val, list):
                continue
            for v in val:
                name = v.get("filename", str(v)) if isinstance(v, dict) else str(v)
                names.append(name[:80])
    return names


def run(name: str) -> None:
    with open(os.path.join(TEMPLATES_DIR, f"{name}.json")) as f:
        workflow = json.load(f)
    patch_inputs(workflow)
    started = time.time()
    res = call("/prompt", {"prompt": workflow, "client_id": str(uuid.uuid4())})
    if "prompt_id" not in res:
        print(
            f"{name}: REJECTED {json.dumps(res, ensure_ascii=False)[:1500]}", flush=True
        )
        return
    hist = wait_history(res["prompt_id"])
    if hist is None:
        print(f"{name}: TIMEOUT {WAIT_TIMEOUT:.0f}s prompt_id={res['prompt_id']}", flush=True)
        return
    status = hist["status"]
    outs = output_names(hist)
    errors = [m for m in status.get("messages", []) if m[0] == "execution_error"]
    detail = errors[0][1].get("exception_message", "")[:800] if errors else ""
    print(
        f"{name}: {status.get('status_str')} {time.time() - started:.0f}s outputs={outs[:4]} {detail}",
        flush=True,
    )


if __name__ == "__main__":
    tone = os.path.join(INPUT_DIR, AUDIO)
    if not os.path.exists(tone):
        write_tone(tone)
    for name in ORDER:
        run(name)
