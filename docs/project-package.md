# Project package

Projectのテンプレート、複製、export/import、backup/restoreは、共通のJSON形式を使う。

- `format`は`mycomfyui.project`で固定する。
- `version`は現在`2`である。version 1は人物設定と入力素材を持たないversion 2へ変換してから検証する。将来の形式変更時も、APIの`_migrate_package`で旧versionから順番に変換する。
- 通常exportはProject設定、人物・参照画像メタデータ、Scene、Shot、Artifact参照を含む。
- backupは通常exportにArtifactと人物参照画像の実体をbase64で加える。人物参照画像はSHA-256単位で重複排除し、`input_files`へ1回だけ格納する。
- APIキー、Cookie、外部サービスの認証情報は含めない。外部参照URLのuserinfo、query、fragmentも除去する。
- import前の事前診断でID衝突、不足ファイル、利用できないRecipe・Workflow、移行先で確認が必要なモデルを表示する。
- Artifact参照のパスはprefix置換できる。置換後も`artifacts/`配下だけを許可する。
- import時はProject、Scene、Shot、Artifactの内部IDを再採番し、package内の参照関係を新しいIDへ張り直す。
- 人物参照画像は`inputs/`配下だけを許可する。import前に実体または`input_files`のbase64について、実形式、サイズ、SHA-256を照合し、backupからのrestoreでは内容アドレス付き入力cacheへ復元する。復号前のbase64長と画像本体の合計をProject package上限以内に制限し、復元先に同名cacheがある場合も内容を再照合する。
- 通常exportに画像実体は含めない。別環境へimportする場合は同じ入力cacheが必要で、無ければ事前診断の不足ファイルへ表示してimport不可とする。
- Scene・Shotを含めない複製では、対応する構造がないためScene・Shotプロンプトも複製しない。
- 構造を含むbackupでは、外部同期で現在の構造から消えたScene・Shotのプロンプトも保持する。
