"""音声Backendの選択。

実GPU Backendを動かせるマシンを用意するまでの間、設定でスタブへ切り替えられる
ようにする。切り替えても上位層の経路は変わらない。
"""

import logging

from mycomfyui_api.adapters.voice.base import VoiceBackend
from mycomfyui_api.adapters.voice.client import VoiceRunnerClient
from mycomfyui_api.adapters.voice.stub import StubVoiceBackend
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)


def create_voice_backend(settings: Settings | None = None) -> VoiceBackend:
    """設定に応じてvoice-runnerクライアントかスタブを返す。

    接続は張らない。runnerが起動していない環境でもApplication APIの起動を止めず、
    音声Jobを実行したときに初めて失敗する。
    """
    settings = settings or get_settings()
    if settings.voice_stub:
        logger.info("スタブの音声Backendを使います。")
        return StubVoiceBackend(settings)
    return VoiceRunnerClient(settings)
