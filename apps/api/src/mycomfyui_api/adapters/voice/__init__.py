"""音声生成とASRのAdapter。

Backendの実体は別venv・別プロセスで動くため、MyComfyUIからは`voice-runner`という
単一のHTTPサービスへ問い合わせる。ローカル構成とリモート構成の差は接続先URLだけに
閉じ込め、実行経路を分岐させない。
"""

from mycomfyui_api.adapters.voice.base import VOICE_ENGINES, VoiceBackend
from mycomfyui_api.adapters.voice.factory import create_voice_backend

__all__ = ["VOICE_ENGINES", "VoiceBackend", "create_voice_backend"]
