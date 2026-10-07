# CIと自動化

この文書では、プルリクエストの検証、定期更新、プラグインのリリースを担うGitHub Actionsと、同じ検証をローカルで実行する方法を説明します。ワークフローの実装は[`.github/workflows`](../.github/workflows)にあり、タスクの依存関係とキャッシュ設定は[`vite.tasks.ts`](../vite.tasks.ts)で管理します。

## ローカルでの検証

miseをシェルで有効にした後、次のコマンドを実行します。Luaを含む一式の検証はLinux x86_64を前提とします。

```shell
mise install --locked
mise run bootstrap
pnpm vp run ci
```

`mise run bootstrap`は`pnpm-lock.yaml`に従ってNode依存を準備し、`lua-rocks.lock`に記録されたrockspecと展開後のソースツリーのSHA-256をビルド前に検証してからLua依存を導入します。`pnpm vp run ci`は次の決定的な検証をまとめて実行します。

- `git diff --check`
- LuaとTypeScriptのフォーマット検査、静的解析、GitHub Actionsの検査
- LuaとTypeScriptのユニットテストと自作コードのカバレッジ検査
- ドキュメント、リポジトリの検査ルール、リリースマニフェストの整合性検査
- プラグインパッケージの再現可能性検査

CIは`check`タスクでフォーマット、リント、カバレッジ付きのユニットテストを実行し、文書・マニフェスト・パッケージの検証を追加します。開発用の`test:unit`はカバレッジを収集せずに同じテストを実行するため、CIからは重ねて呼びません。

Node側のフォーマット検査には`vp fmt --check`、リントと型検査には`vp lint`を使います。型検査は`vite.config.ts`の`typeCheck: true`で有効にしています。

実際の公式CDNとツールマネージャーを使うE2Eは、ネットワークと利用者の状態へ依存するため`ci`には含まれません。必要なバックエンドを個別に実行します。

```shell
pnpm vp run e2e
pnpm vp run e2e:vfox
```

単体のvfoxのE2Eはvfoxの利用者の状態を使います。通常は一時的なCI環境で実行し、手元で実行する場合は既存のvfox設定へ影響し得ることを確認してください。

個別の検証と保守には次のタスクを使います。

| コマンド | 用途 |
| --- | --- |
| `pnpm vp run check` | 整形、静的解析、テスト、100%カバレッジ検証をまとめて実行 |
| `pnpm vp run fmt:check` / `pnpm vp run lint` | 整形と静的解析 |
| `pnpm vp run test:unit` / `pnpm vp run coverage` | 単体テストをカバレッジなし／ありで実行 |
| `pnpm vp run docs:check` / `pnpm vp run update:check` | 文書とリリースマニフェストの検証 |
| `pnpm vp run package` | 再現可能なプラグインパッケージを生成 |
| `pnpm vp run update:discover` | 配布元のMoonBitリリースの成果物がすべて揃ったことを検出 |
| `mise run update:tooling` | 互換範囲内でツール、npm、Lua rocks、GitHub Actionsの固定情報を更新 |

## プルリクエストとmainのCI

[`ci.yml`](../.github/workflows/ci.yml)はプルリクエスト、`main`へのプッシュ、手動実行で起動します。同じプルリクエストまたはGit参照に対する古い実行は、新しい実行が始まるとキャンセルされます。

| ジョブ | 実行環境 | 検証内容 |
| --- | --- | --- |
| `quality` | Ubuntu 24.04 x86_64 | exact manifestの不変性、PRで変わる依存の脆弱性レビュー、全開発ツールの固定情報、`pnpm vp run ci` |
| `mise-lock` | Ubuntu 24.04 x86_64 | 最新安定版miseが`mise.lock`を解決できること |
| `mise-e2e` | Ubuntu x86_64 / arm64、macOS arm64、Windows x86_64 | mise経由で公式MoonBitをダウンロード、インストール、有効化してテスト用プロジェクトを実行 |
| `vfox-e2e` | Ubuntu x86_64 / arm64、macOS arm64、Windows x86_64 | 単体のvfox経由で同じ実ダウンロード検証を実行 |
| `required` | Ubuntu 24.04 x86_64 | 上記4グループがすべて成功したことを一つの結果へ集約 |

プルリクエストでは、既に`main`へ存在する`releases/<exact-version>.json`を変更すると`quality`が失敗します。新しいexact manifestと`releases/latest.json`は追加・更新できますが、公開済みの記録は変更不可です。

リポジトリのルールセットでは`required`を必須チェックとして扱います。個別のマトリクスジョブの追加や名前の変更があっても、マージ条件はこの集約ジョブで安定して判定できます。

## バージョンの固定とmise最新検証

互換範囲から解決したバージョンをロックファイルへ記録し、通常のインストールではその記録を使います。

- Node、pnpm、Lua、LuaRocks、ワークフロー検査ツールは`mise.toml`で互換範囲を指定し、`mise.lock`で固定します。
- Node依存は`package.json`で互換範囲を指定し、推移依存も含めて`pnpm-lock.yaml`で固定します。
- Luaのテスト依存は`scripts/lua-rocks.sh`で更新対象の系列を指定し、バージョンとソースコードのハッシュを`lua-rocks.lock`で固定します。

pnpm本体の取得と更新はmiseが担当し、`package.json`の`engines.pnpm`は対応系列の確認に使います。

mise本体は最新安定版との互換性を確認するため、固定の対象外とします。すべてのワークフローでmise-actionの`minimum_release_age: "0s"`と`cache: false`を明示し、公開からの待機時間を設けず最新安定版を取得します。アクション自体のコードはコミットSHAへ固定します。

各ジョブの`Record mise version`ステップは`mise --version`を実行し、実際に使った版をログへ残します。同じコミットでも後日の再実行ではmiseの版が変わり得るため、失敗を調べる際はこのログも確認します。これは最新miseとの互換性を優先する例外であり、開発ツールや依存の固定は引き続き維持します。

## キャッシュ

GitHub ActionsはpnpmストアをOS、アーキテクチャ、`pnpm-lock.yaml`のハッシュごとにキャッシュします。`node_modules`内の依存パッケージは共有せず、各実行で`pnpm install --frozen-lockfile`または`bootstrap`を実行します。

`quality`は`node_modules/.vite/task-cache`も復元します。Vite Taskはタスクごとに宣言した入力からフィンガープリントを作り、変更されていない検証を再利用します。テストの入力には、ソースコードに加えてテスト用データとして読むマニフェスト、文書、ワークフロー、同梱した外部コードも含めます。カバレッジレポートと`dist`はキャッシュ対象の生成物として復元されます。

E2E、配布元の最新版検出、リリースはネットワークや外部状態へ依存するためキャッシュしません。`ci`のリポジトリのルール検査と`git diff --check`もGitの追跡ファイル一覧、リモート、インデックスの状態へ依存するため毎回実行しますが、依存タスクのキャッシュは再利用します。

キャッシュヒットは性能だけに影響します。キャッシュが存在しない場合も、固定済みの依存から同じ検証を完了できる構成です。

## MoonBit最新版の更新

[`update-latest.yml`](../.github/workflows/update-latest.yml)は毎日00:17 UTC（日本時間09:17）と手動実行で起動します。アップデーターは全対応プラットフォームのツールチェーンとcoreが同じバージョンで揃い、チェックサム、アーカイブ構造、インストール手順が検証できた場合だけリリースマニフェストを更新します。

| 検出結果 | 自動化の挙動 |
| --- | --- |
| 変更なし | 何も作成せず正常終了 |
| 公開途中 | 更新を延期し、最初に検出した時刻をアーティファクトへ保存 |
| 24時間以上公開途中 | 重複しない保守用のIssueを作成 |
| 安全に昇格できる最新版 | `automation/moonbit-latest`の単一PRを作成または更新し、スカッシュ方式の自動マージを設定 |
| インストーラー、導入方式、レイアウト、バージョンのスキーマ、メジャーバージョンの変化 | `automation/moonbit-manual-review`へ記録し、手動レビュー用PRとIssueを作成 |
| 3回連続のワークフロー失敗 | 重複しない障害Issueを作成 |

通常のアップデーターPRが変更できるのは`releases/*.json`だけです。既存リリースメタデータの削除と、その他のパスへの変更はワークフロー内の許可リスト検査で拒否します。アップデーターは`main`へ直接プッシュしません。手動レビュー用PRは自動マージされません。

## 開発ツールと依存の更新

[`update-tooling.yml`](../.github/workflows/update-tooling.yml)は毎週月曜日03:30 JST（日曜日18:30 UTC）と手動実行で起動します。`mise run update:tooling`が、設定済みの互換範囲内でmiseのツール、npm依存、Vite+と関連パッケージ、Luaのテスト用rocks、GitHub Actionsの固定情報をまとめて更新します。

アップデーターは更新したロックファイルに従ってNodeとpnpmをインストールし、その実行パスへ切り替えてからnpm依存を更新します。

GitHub Actionsはワークフロー内で省略しないコミットSHAへ固定し、末尾の`# vN`を更新対象のメジャーバージョンとして保持します。アップデーターは各アクションのリポジトリの最新安定版リリースタグを検索し、同じメジャーバージョン内のコミットSHAだけを更新します。メジャーバージョンのタグそのものを実行時に参照しないため、配布元側でタグが動いてもレビューなしにCIのコードは変わりません。

Luaテストツールの更新対象は、`scripts/lua-rocks.sh`内でBusted 2、LuaCov 0.16、Luacheck 1系列に固定しています。アップデーターは直接指定したツールと推移依存を解決し、各バージョン、配布元のrockspecのSHA-256、展開後のソースツリーのSHA-256を`lua-rocks.lock`へ記録します。同じバージョンの内容が以前のハッシュと異なる場合は、供給元が公開済みの内容を変更したものとして停止します。

Vite+ coreを`vite`へ割り当てるエイリアスについてはVite+ 1系列だけをピア依存関係のルールで許可し、その他のピア依存関係の不整合をCIで拒否します。

変更可能なファイルは`.github/workflows/*.yml`、`lua-rocks.lock`、`mise.lock`、`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`だけです。差分があれば`automation/maintenance-tooling`の単一PRを作成または更新します。このPRは自動マージせず、週1回、保守者が差分、`required`の成功、依存関係レビューの結果を確認してマージします。

メジャーバージョン系列、Lua rockの許可範囲、ツールの導入方式の変更は自動化の対象外です。互換性の判断が必要なため、これらは必要になった時点で個別の手動PRとして扱います。

CI失敗や緊急の脆弱性、配布元の仕様変更には随時対応するため、週1回は通常時の目安です。依存関係レビューはGitHubが認識する依存と公開済みのセキュリティアドバイザリを対象とし、Lua rocksの内容照合は`lua-rocks.lock`のハッシュ検証が担当します。

新しい依存を解決するステップでは書き込み権限を持つトークンを使用しません。依存更新とリポジトリのルール検査が完了した後にGitHub Appの短期トークンを発行し、許可されたファイルを自動化用ブランチへプッシュします。

## プラグインのリリース

[`release.yml`](../.github/workflows/release.yml)は`v*.*.*`形式のタグをプッシュしたときに起動します。MoonBitのバージョンではなく、`metadata.lua`に記録したプラグイン自身のSemVerをタグに使います。

ワークフローはソースコードをもう一度検証し、リポジトリのオーナーを確認してから、同じ入力から常に同じバイト列になるZIPとSHA-256ファイルを生成します。GitHubのアーティファクトアテステーションを作成し、タグと同名のGitHub ReleaseへZIPとチェックサムを公開します。最後に`manifest`リリースの`manifest.json`を新しいプラグインバージョンへ更新します。MoonBitの`latest`のマニフェストだけが更新された場合、プラグインリリースは作成しません。

リリース前には、`metadata.lua`のバージョンとREADMEのダウンロードURLを同じバージョンへ更新したPRをマージし、`main`の`required`が成功していることを確認します。そのコミットへタグを作成するとリリースワークフローが全検証と公開を行います。

## 権限とリポジトリ設定

ワークフローは既定権限を読み取り専用または空にし、ジョブごとに必要な権限だけを付与します。チェックアウト時は認証情報を保持しません。MoonBitと開発ツールのアップデーターがブランチとPRを操作するときだけリポジトリ専用GitHub Appの短期トークンを使います。

リポジトリには次のActions設定が必要です。

| 種類 | 名前 | 用途 |
| --- | --- | --- |
| Variable | `MOONBIT_UPDATER_CLIENT_ID` | リポジトリ専用GitHub AppのクライアントID |
| Secret | `MOONBIT_UPDATER_PRIVATE_KEY` | Appトークン生成に使う秘密鍵 |
| Repository setting | Allow auto-merge | MoonBitの最新版PRを必須CI成功後にスカッシュマージ |
| Ruleset | Required check `required` | CIグループが一つでも失敗した変更のマージを防止 |

GitHub AppにはMetadata read、Contents write、Pull requests write、Workflows writeを付与し、このリポジトリへインストールします。Workflows writeはSHA固定されたアクションを週次PRで更新するためだけに使います。Issue作成、ワークフロー履歴の参照、リリース公開には各ワークフローの制限付き`GITHUB_TOKEN`を使います。Appにルールセットの迂回権限は与えません。

週次更新を有効にする際は、[GitHub Apps設定](https://github.com/settings/apps)からリポジトリ専用AppのPermissions & eventsを開き、Repository permissionsのWorkflowsをRead and writeにして保存します。その後、[Installed GitHub Apps](https://github.com/settings/installations)から当該Appの更新された権限を承認します。この設定は一度だけ必要です。ワークフローを`main`へ反映した後、Update maintenance toolsを手動実行し、更新があれば単一PRとそのCIが作成されることを確認します。

## 失敗時の確認

| 症状 | 最初に確認する箇所 |
| --- | --- |
| `quality`だけ失敗 | 失敗したVite Task、フォーマット差分、カバレッジ、リポジトリチェッカーとドキュメントチェッカー |
| 特定OSのE2Eだけ失敗 | 対象プラットフォームの公式アーカイブ、PowerShellまたはシェルのログ、インストール先ルートと`MOON_HOME`の検証 |
| 全E2Eが同時に失敗 | 公式CDN、`latest`のマニフェスト、mise/vfoxの共通変更 |
| `required`だけ失敗したように見える | `needs`にある4グループのうち、失敗またはキャンセルされたジョブ |
| アップデーターが変更を作らない | `Discover a complete upstream release`の出力。公開途中は成功扱いで延期される |
| アップデーターが終了コード2 | 手動レビュー用PRとIssue。インストーラー、導入方式、レイアウト、スキーマ、メジャーバージョンの差分を確認 |
| 開発ツールのアップデーターが失敗 | 互換範囲、Lua rockの同一バージョンでのハッシュ変化、アクションのリリースタグ、許可リスト外の変更、AppのWorkflows write承認、既存の自動化用ブランチとのマージ競合 |
| リリースが失敗 | タグ、`metadata.lua`のバージョン、`origin`のURL、決定的CI、アテステーション権限 |

失敗を再実行する前に、同じコミットでローカルの`pnpm vp run ci`を実行します。外部サービスの一時障害と判断できる場合だけGitHub Actionsの再実行を使い、再現する失敗は修正PRで扱います。
