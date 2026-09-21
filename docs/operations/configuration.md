# 保存先と既存作品参照の設定

MyComfyUIはSQLite、生成物、入力素材、実行中の一時ファイルを`data_root`配下へ保存する。既定値はOS標準の利用者データ領域であり、リポジトリ、既存作品、生成Backendの出力ディレクトリは管理対象にしない。

既存作品はai-media参照APIから読取り専用で取得する。MyComfyUIは`novel-writer`などの作品正本を直接読まず、書き換えない。

## 設定ファイル

既定の設定ファイルはOS標準の利用者設定ディレクトリにある`MyComfyUI/config.toml`である。追跡対象の[設定例](../../config/mycomfyui.example.toml)をコピーし、必要な項目だけを有効にする。

LinuxではOS標準の設定ディレクトリ配下の`MyComfyUI/config.toml`へ設定例をコピーする。

WindowsとmacOSではplatformdirsが各OS標準の設定ディレクトリを選ぶ。別の設定ファイルを使うときは`mycomfyui-api --config-file /path/to/config.toml`を指定する。

`data_root`にはMyComfyUI専用のディレクトリを指定する。保存レイアウトは次のとおり。

|相対先|内容|
|---|---|
|`db/mycomfyui.sqlite3`|Project、Job、Artifact、Manifestなどの正本|
|`artifacts/<job-id>/`|生成物、Workflow、実行ログ|
|`inputs/<sha256>/`|取り込んだ利用者素材のcache|
|`tmp/`|実行途中の一時ファイルと提案Providerの作業領域|
|`logs/`|診断ログ|

`data_root`内の内容はGit管理しない。Project packageのexport、backup、restoreを使う場合も、認証情報は含めない。

## 既存作品への接続

上流のai-media参照APIが利用できる場合は、ユーザー設定へ`aimedia_base_url`を指定する。参照APIはProject、Scene、Shot、Canonを読取り専用で返す必要がある。接続後は画面から外部作品をインポートし、同期時もMyComfyUI側のスナップショットだけを更新する。

上流参照APIが未提供、または`aimedia_base_url`を設定していない場合は、同梱fixtureを使う。これは代表作品の画面・同期経路を確認するためのもので、既存作品のファイルを探索する機能ではない。検証用fixtureを使う場合だけ`aimedia_fixture_path`でJSONファイルを指定する。

## 優先順位と秘密情報

設定値はアプリケーション既定値、ユーザー設定TOML、`.env`、`MYCOMFYUI_`環境変数、起動時引数の順に上書きする。起動時引数は`--data-root`、`--aimedia-base-url`、`--aimedia-fixture-path`、`--config-file`を使える。

APIキー、Cookie、token、認証headerをTOML、`.env`、SQLite、Manifest、Artifact名、ログへ保存しない。これらが必要な上流サービスはOS資格情報ストアまたは実行環境の秘密情報管理へ置く。
