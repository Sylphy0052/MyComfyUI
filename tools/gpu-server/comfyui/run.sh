#!/bin/bash
# g18上で実行: ./run.sh <gpu_index>。常駐させず、使い終えたら docker stop kfuruhashi-comfyui
set -eu
GPU=${1:?gpu index}
D=/ssdnas2/data/kfuruhashi
docker run -d --rm --init --name kfuruhashi-comfyui --gpus "device=${GPU}" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -p 127.0.0.1:18188:8188 \
  -v $D/ComfyUI:/ComfyUI -v $D/comfyui-models:/models \
  -v $D/docker/comfyui/extra_model_paths.yaml:/ComfyUI/extra_model_paths.yaml:ro \
  kfuruhashi-comfyui:cu130 python main.py --listen 0.0.0.0 --port 8188
