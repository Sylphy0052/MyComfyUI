#!/bin/bash
# g18上で実行 (ssh.exe g18 'bash -s' < this): 不足モデルを配布元(HF)からコンテナ内で取得する
set -Eeuo pipefail
D=/ssdnas2/data/kfuruhashi
docker run -i --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e HF_HOME=/tmp/hf \
  -v "$D/ComfyUI:/ComfyUI" -v "$D/comfyui-models:/models" kfuruhashi-comfyui:cu130 python - <<'EOF'
import os, shutil
import huggingface_hub as h

FILES = [
    ("darask0/Anima-InContext-Character", "anima-incontext-character.safetensors", "/models/loras"),
    ("Comfy-Org/ACE-Step_ComfyUI_repackaged", "all_in_one/ace_step_v1_3.5b.safetensors", "/models/checkpoints"),
    ("Kim2091/UltraSharp", "4x-UltraSharp.pth", "/models/upscale_models"),
    ("stable-diffusion-v1-5/stable-diffusion-v1-5", "v1-5-pruned-emaonly.safetensors", "/models/checkpoints"),
    ("comfyanonymous/ControlNet-v1-1_fp16_safetensors", "control_v11p_sd15_canny_fp16.safetensors", "/models/controlnet"),
]
for repo, name, dest in FILES:
    target = os.path.join(dest, os.path.basename(name))
    if os.path.exists(target):
        print("skip", target, flush=True)
        continue
    os.makedirs(dest, exist_ok=True)
    stage = os.path.join(dest, ".stage")
    path = h.hf_hub_download(repo, name, local_dir=stage)
    shutil.move(path, target)
    shutil.rmtree(stage)
    print("ok", target, os.path.getsize(target), flush=True)

siglip = "/ComfyUI/models/siglip2/siglip2-base-patch16-512"
h.snapshot_download("google/siglip2-base-patch16-512", local_dir=siglip,
                    allow_patterns=["*.json", "*.safetensors", "tokenizer.model"])
print("ok", siglip, sorted(os.listdir(siglip)), flush=True)
EOF
