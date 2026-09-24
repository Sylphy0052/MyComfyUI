"""Application APIを起動するエントリ。

`python -m mycomfyui_api`と固めた実行ファイルは同じ経路を通る。起動時の設定は
ここで受ける引数と環境変数だけに寄せる。

引数は`MYCOMFYUI_`接頭辞の環境変数へ移してから`Settings`を1度だけ読む。設定の
読み取り口を2つに増やさないため、引数の値も必ず環境変数を経由させる。
"""

import argparse
import os
import socket
import sys
from collections.abc import Sequence

import uvicorn
from pydantic import ValidationError

from mycomfyui_api.settings import get_settings

#: 待ち受け先を起動元へ渡すための行頭。portに0を渡したとき、実際に割り当て
#: られたportはこの行からしか判らない。書式を変えると利用者が壊れる。
LISTENING_PREFIX = "MYCOMFYUI_API_LISTENING"

#: 設定の値が不正で起動できなかったときの終了コード。
EXIT_INVALID_SETTINGS = 20
#: 指定されたhostとportにbindできなかったときの終了コード。
EXIT_BIND_FAILED = 21


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="mycomfyui-api",
        description="MyComfyUI Application APIを起動する。",
    )
    parser.add_argument(
        "--host",
        help="bindするhost。既定は127.0.0.1。loopback以外は認証が無いまま公開される。",
    )
    parser.add_argument(
        "--port",
        type=int,
        help="bindするport。0を渡すとOSが空きportを選ぶ。既定は8000。",
    )
    parser.add_argument(
        "--data-root",
        help="DBと資産の保存先。空のディレクトリを渡すと起動時にDBを作る。",
    )
    parser.add_argument(
        "--config-file",
        help="ユーザー設定TOML。省略時はOS標準の設定ディレクトリのconfig.tomlを読む。",
    )
    parser.add_argument(
        "--aimedia-base-url",
        help="既存作品を参照するai-media APIのURL。未指定時はfixtureを使う。",
    )
    parser.add_argument(
        "--aimedia-fixture-path",
        help="ai-media API未接続時に使う参照fixtureのJSONファイル。",
    )
    parser.add_argument(
        "--aimedia-repository-root",
        help="ai-media実データを読むnovel-writerのgitリポジトリ。fixtureより優先する。",
    )
    parser.add_argument(
        "--allow-origin",
        action="append",
        metavar="ORIGIN",
        help="ブラウザからの呼び出しを許すorigin。複数回指定できる。",
    )
    parser.add_argument(
        "--log-level",
        default="info",
        help="uvicornのログレベル。既定はinfo。",
    )
    return parser.parse_args(argv)


def _apply_overrides(args: argparse.Namespace) -> None:
    """引数で渡された値だけを環境変数へ移す。

    渡されなかった項目は環境変数と`Settings`の既定値をそのまま使う。
    """
    if args.config_file is not None:
        os.environ["MYCOMFYUI_CONFIG_FILE"] = args.config_file
    if args.data_root is not None:
        os.environ["MYCOMFYUI_DATA_ROOT"] = args.data_root
    if args.aimedia_base_url is not None:
        os.environ["MYCOMFYUI_AIMEDIA_BASE_URL"] = args.aimedia_base_url
    if args.aimedia_fixture_path is not None:
        os.environ["MYCOMFYUI_AIMEDIA_FIXTURE_PATH"] = args.aimedia_fixture_path
    if args.aimedia_repository_root is not None:
        os.environ["MYCOMFYUI_AIMEDIA_REPOSITORY_ROOT"] = args.aimedia_repository_root
    if args.host is not None:
        os.environ["MYCOMFYUI_API_HOST"] = args.host
    if args.port is not None:
        os.environ["MYCOMFYUI_API_PORT"] = str(args.port)
    if args.allow_origin:
        os.environ["MYCOMFYUI_ALLOWED_ORIGINS"] = ",".join(args.allow_origin)
    # 先に読まれていた設定を捨てる。引数を反映しないまま起動するのを防ぐ。
    get_settings.cache_clear()


def _bind(host: str, port: int) -> socket.socket:
    """待ち受けるsocketを先に確保する。

    portに0を渡すと、割り当てられたportはbindするまで判らない。uvicornへ任せると
    起動後まで取り出せず、親プロセスへ知らせる前に要求が来うる。ここで確保して
    から番号を伝える。

    `SO_REUSEADDR`は設定しない。Windowsでは既にlistenしているsocketと同じportへの
    bindまで許すため、待ち受けを横取りされうる。APIは認証を持たないため、使用中の
    portでは黙って同居せず、bindに失敗させる。
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind((host, port))
    sock.set_inheritable(True)
    return sock


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    _apply_overrides(args)
    # 起動できない理由は親プロセスが読む。tracebackのまま落とすと、次に何をすれば
    # よいかが伝わらない。終了コードで原因を分け、要約を標準エラーへ出す。
    try:
        settings = get_settings()
    except ValidationError as error:
        print(f"設定の値が不正です。\n{error}", file=sys.stderr, flush=True)
        return EXIT_INVALID_SETTINGS

    try:
        sock = _bind(settings.api_host, settings.api_port)
    except OSError as error:
        print(
            f"{settings.api_host}:{settings.api_port}にbindできません。"
            f"portの使用状況とbind先を確かめてください。\n{error}",
            file=sys.stderr,
            flush=True,
        )
        return EXIT_BIND_FAILED

    try:
        bound_host, bound_port = sock.getsockname()[:2]
        # 設定を読み終えてから読み込む。`create_app`がimport時に設定を参照するため、
        # 先に読むと引数が効かない。
        from mycomfyui_api.main import app

        # ログレベルだけはuvicornの起動にしか使わないため、`Settings`へ載せない。
        # `proxy_headers`の既定は有効で、loopbackからの要求だけは
        # `X-Forwarded-For`でclient hostを上書きできる。WebSocketの許可判定は
        # client hostを見るため、前段にproxyを置かない本構成では無効にして、
        # 接続元を実際のTCP peerだけで判断する。
        config = uvicorn.Config(app, log_level=args.log_level, proxy_headers=False)
        server = uvicorn.Server(config)
        # 親プロセスはこの行でport確定を知る。bufferingで遅れないよう即座に流す。
        print(f"{LISTENING_PREFIX} http://{bound_host}:{bound_port}", flush=True)
        server.run(sockets=[sock])
    finally:
        # 起動に至らず抜けたときもsocketを手放す。同じプロセスから再び起動できる
        # ようにしておく。uvicornが閉じた後の2度目の呼び出しは何もしない。
        sock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
