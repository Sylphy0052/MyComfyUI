"""ComfyUI Backendの選択。

到達できるComfyUIを用意するまでの間、設定でスタブへ切り替えられるようにする。
切り替えても上位層の経路は変わらない。
"""

import logging

from mycomfyui_api.adapters.comfyui.client import ComfyUIClient
from mycomfyui_api.adapters.comfyui.stub import StubComfyUIClient
from mycomfyui_api.settings import Settings, get_settings

logger = logging.getLogger(__name__)


def create_comfyui_client(settings: Settings | None = None):
    """設定に応じてComfyUIクライアントかスタブを返す。

    接続は張らない。ComfyUIが起動していない環境でもApplication APIの起動を止めず、
    Jobを実行したときに初めて失敗する。
    """
    settings = settings or get_settings()
    if settings.comfyui_stub:
        logger.info("スタブのComfyUI Backendを使います。")
        return StubComfyUIClient(settings)
    return ComfyUIClient(settings)
