FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends git gcc libc6-dev libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir torch torchvision --index-url https://download.pytorch.org/whl/cu130
COPY requirements.txt /tmp/requirements.txt
RUN grep -Ev '^(torch|torchvision)$' /tmp/requirements.txt > /tmp/req.txt && pip install --no-cache-dir -r /tmp/req.txt
RUN pip install --no-cache-dir onnxruntime
WORKDIR /ComfyUI
EXPOSE 8188
