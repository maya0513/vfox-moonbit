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
| `mise run update:lua` | 互換系列内のLua rocksと検証用ハッシュを更新 |

## プルリクエストとmainのCI

[`ci.yml`](../.github/workflows/ci.yml)はプルリクエスト、`main`へのプッシュ、手動実行で起動します。同じプルリクエストまたはGit参照に対する古い実行は、新しい実行が始まるとキャンセルされます。

| ジョブ | 実行環境 | 検証内容 |
| --- | --- | --- |
| `quality` | Ubuntu 24.04 x86_64 | exact manifestの不変性、PRで変わる依存の脆弱性レビュー、全開発ツールの固定情報、`pnpm vp run ci` |
| `dependency_artifacts` | Ubuntu 24.04 x86_64 | 選択済みmiseロックとVite+依存グラフの同期を、認証情報を使わず検証 |
| `mise-e2e` | Ubuntu x86_64 / arm64、macOS arm64、Windows x86_64 | mise経由で公式MoonBitをダウンロード、インストール、有効化してテスト用プロジェクトを実行 |
| `vfox-e2e` | Ubuntu x86_64 / arm64、macOS arm64、Windows x86_64 | 単体のvfox経由で同じ実ダウンロード検証を実行 |
| `required` | Ubuntu 24.04 x86_64 | 上記4グループがすべて成功したことを一つの結果へ集約 |

プルリクエストでは、既に`main`へ存在する`releases/<exact-version>.json`を変更すると`quality`が失敗します。新しいexact manifestと`releases/latest.json`は追加・更新できますが、公開済みの記録は変更不可です。

リポジトリのルールセットでは`required`を必須チェックとして扱います。個別のマトリクスジョブの追加や名前の変更があっても、マージ条件はこの集約ジョブで安定して判定できます。

## バージョンの固定とmise最新検証

miseのツールはexact版で宣言し、通常のインストールではロックに記録した依存グラフとチェックサムを使います。

- Node、pnpm、Lua、LuaRocks、ワークフロー検査ツールは`mise.toml`でexact版を指定し、`mise.lock`で固定します。
- Node依存は`package.json`で互換範囲を指定し、推移依存も含めて`pnpm-lock.yaml`で固定します。
- Luaのテスト依存は`scripts/lua-rocks.sh`で更新対象の系列を指定し、バージョンとソースコードのハッシュを`lua-rocks.lock`で固定します。

Nodeとpnpmの取得はmiseが担当します。Renovate向けに`package.json`の`engines.node`と`packageManager`にも同じexact版を宣言し、宣言・ロック・実行版の一致をCIで検証します。`pmOnFail: error`により宣言と異なる実行版を拒否します。pnpmのlockfileにも選択済みpackage managerの依存を記録しますが、実行ファイルの取得はmiseが担当します。Luaは5.1系を維持し、Nodeの型定義は実行版と同じメジャーに揃えます。

mise本体は最新安定版との互換性を確認するため、固定の対象外とします。このリポジトリで定義するmise導入ステップではmise-actionの`minimum_release_age: "0s"`と`cache: false`を明示し、公開からの待機時間を設けず最新安定版を取得します。アクション自体のコードはコミットSHAへ固定します。

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

[Renovate設定](../renovate.json)はmaya0513/renovate-configの共通defaultとVite+ presetを継承します。更新は日本時間の火曜日、公開後7日の待機を経て提案されます。non-majorとロック保守は必須CIと必要なCODEOWNERS承認を満たせば自動マージし、major、runner環境、共通ワークフロー参照の変更は手動で確認します。火曜日は更新を受け付ける期間であり、実行時刻やPRが一つになることを保証するものではありません。

npm、mise、GitHub Actionsの更新版はRenovateが選びます。Nodeとpnpmは、それぞれmiseとpackage.jsonの宣言を同じPRで更新します。共通mise-pnpmプリセットがRenovate自身のmise生成物更新とロック保守を無効にし、miseロックは共通mise準備アクションに集約します。独立したVite+プリセットも選択し、派生依存の宣言同期をVite+準備アクションへ任せます。pnpm更新のnpm生成処理は有効のままにし、package manager用のロック文書もRenovateが更新します。アクションは省略しないコミットSHAへ固定し、対応バージョンをコメントで記録します。承認済みの共通アクションと公開ワークフローは同じSHA固定と`# main`を使います。miseの最低版とvfoxのランタイム下限は別途手動で判断します。

[`update-dependencies.yml`](../.github/workflows/update-dependencies.yml)は、1つの準備ジョブで3つの共通アクションを順に実行します。`mise-pnpm`がmiseロックとNode／pnpmを準備し、`pnpm-viteplus`がcoverage、Vitest override、Vite core aliasを選択済みのVite+に同期し、`pnpm-outputs`が全生成物を検証します。準備状態を次の処理へ渡し、検証モードも引き継ぎます。準備はMend Renovateによる`renovate/`ブランチへのプッシュだけで動作し、App認証情報は受け取りません。Vite+の再選択や旧来の一括更新処理は行いません。同梱パッケージの独立更新は止めるため、Vite+経由で未提供の脆弱性修正は手動で対応します。

専用の公開ジョブが`publish-pnpm-artifacts.yml`を呼び、検証済みのbase SHA・変更有無・変更不能なartifact IDを渡します。miseとVite+の生成物を明示的に許可し、このジョブだけに既存のApp認証情報を渡します。公開処理はパッチを検査し、元のSHAを条件とするlease付きで必要な場合だけ追加の1コミットをプッシュします。Appのプッシュでは再生成せず、PRのCIが最新SHAを検証します。

通常CIも同じ3つのアクションを検証モードで実行し、結果を`required`に含めます。Appの認証情報は渡しません。両方の呼び出しで、Conda GCC／Lua／LuaRocksはLinux x64／arm64、その他はLinux x64／arm64・macOS arm64・Windows x64を指定します。Condaは記録済みの依存をインストールし、通常CIでは再解決しません。その他は選択済みexact版から再生成して差分を確認します。ツールの漏れ・重複、対象環境の不足、共通リビジョンの不一致、準備状態や公開出力の接続漏れ、準備への認証情報の混入も設定検査で拒否します。

Vite+のプリセット名は`viteplus`です。プリセットは共通`main`を追従し、共通アクションと公開ワークフローの実装は同じレビュー済みの省略しないコミットSHAに固定します。生成される`pnpm-workspace.yaml`の値の書式は共通同期処理に任せ、フォーマッターの対象から外します。リポジトリ検査はYAMLを解析し、引用符の違いによらずstore・override・peer policyを検証します。

npmのロック保守は宣言範囲内で行います。pnpm側に追加の待機設定は設けず、Renovateの7日待機が推移依存やロック保守の全更新に及ぶとは保証しません。依存関係レビューとfrozen installは引き続き必須です。`renovate/artifacts`は診断用であり、通常PRの必須チェックにはしません。

## Luaのテスト依存の更新

[`update-lua-rocks.yml`](../.github/workflows/update-lua-rocks.yml)は毎週月曜日03:30 JSTと手動実行で起動します。`mise run update:lua`がBusted 2、LuaCov 0.16、Luacheck 1の互換系列内でLua rocksだけを更新し、バージョン、rockspecのSHA-256、展開したソースのSHA-256を記録します。同じ版の内容が変わった場合は停止します。

ワークフローは必要なNode・GCC・Lua・LuaRocksを`mise install --locked`で準備します。タスク起動時には`--skip-tools`で自動インストールを省き、無関係なツールの準備に伴う`mise.lock`の変更を防ぎます。

変更できるのは`lua-rocks.lock`だけです。`automation/lua-rocks`の単一ブランチで週1回の手動レビュー用PRを管理し、npm・mise・ワークフローの変更は拒否します。MoonBitの日次更新はRenovateから独立して継続します。

## プラグインのリリース

[`release.yml`](../.github/workflows/release.yml)は`v*.*.*`形式のタグをプッシュしたときに起動します。MoonBitのバージョンではなく、`metadata.lua`に記録したプラグイン自身のSemVerをタグに使います。

ワークフローはソースコードをもう一度検証し、リポジトリのオーナーを確認してから、同じ入力から常に同じバイト列になるZIPとSHA-256ファイルを生成します。GitHubのアーティファクトアテステーションを作成し、タグと同名のGitHub ReleaseへZIPとチェックサムを公開します。最後に`manifest`リリースの`manifest.json`を新しいプラグインバージョンへ更新します。MoonBitの`latest`のマニフェストだけが更新された場合、プラグインリリースは作成しません。

リリース前には、`metadata.lua`のバージョンとREADMEのダウンロードURLを同じバージョンへ更新したPRをマージし、`main`の`required`が成功していることを確認します。そのコミットへタグを作成するとリリースワークフローが全検証と公開を行います。

## 権限とリポジトリ設定

ワークフローは既定権限を読み取り専用または空にし、ジョブごとに必要な権限だけを付与します。チェックアウト時は認証情報を保持しません。MoonBitとLuaのアップデーターがブランチとPRを操作するときと、依存生成物を専用の公開ジョブからプッシュするときにリポジトリ専用GitHub Appの短期トークンを使います。

リポジトリには次のActions設定が必要です。

| 種類 | 名前 | 用途 |
| --- | --- | --- |
| Variable | `MOONBIT_UPDATER_CLIENT_ID` | リポジトリ専用GitHub AppのクライアントID |
| Secret | `MOONBIT_UPDATER_PRIVATE_KEY` | Appトークン生成に使う秘密鍵 |
| Repository setting | Dependency graph | PRの依存関係レビューに必要。Settings → Advanced Securityで有効化 |
| Repository setting | Allow auto-merge | 自動マージ対象のMoonBit・Renovate PRを必須チェックと承認後にスカッシュマージ |
| Ruleset | Required check `required` | CIグループが一つでも失敗した変更のマージを防止 |

リポジトリ専用GitHub AppにはMetadata read、Contents write、Pull requests writeを付与し、ルールセットの迂回権限は与えません。アクションの更新はRenovate自身のAppが担当するため、Workflows writeは要求しません。共通ワークフローの公開ジョブはContents writeだけを要求し、PRの検証にはApp認証情報を渡しません。Issue作成、履歴の参照、リリースには各ワークフローの制限付きGITHUB_TOKENを使います。

導入後はUpdate Lua test dependenciesを手動実行し、変更があれば作られたPRを確認します。実際のRenovate更新では、同期が無関係な変更を作らないことと、追加コミットの最新SHAでCIが再実行されることを確認します。CODEOWNERS承認、必須チェック、最新mainへの追従条件は維持します。

## 失敗時の確認

| 症状 | 最初に確認する箇所 |
| --- | --- |
| `quality`だけ失敗 | 失敗したVite Task、フォーマット差分、カバレッジ、リポジトリチェッカーとドキュメントチェッカー |
| 特定OSのE2Eだけ失敗 | 対象プラットフォームの公式アーカイブ、PowerShellまたはシェルのログ、インストール先ルートと`MOON_HOME`の検証 |
| 全E2Eが同時に失敗 | 公式CDN、`latest`のマニフェスト、mise/vfoxの共通変更 |
| `required`だけ失敗したように見える | `needs`にある4グループのうち、失敗またはキャンセルされたジョブ |
| アップデーターが変更を作らない | `Discover a complete upstream release`の出力。公開途中は成功扱いで延期される |
| アップデーターが終了コード2 | 手動レビュー用PRとIssue。インストーラー、導入方式、レイアウト、スキーマ、メジャーバージョンの差分を確認 |
| 依存生成物の検証が失敗 | Node／pnpmの宣言不一致、対象環境の不足、古いロック、coverage／Vitestの不一致、内蔵Vitestのメジャー変更。選択済みの版から再生成する |
| Luaアップデーターが失敗 | 同じrock版の内容の変化、Lua依存の互換性、lua-rocks.lock以外の変更、ブランチの競合 |
| リリースが失敗 | タグ、`metadata.lua`のバージョン、`origin`のURL、決定的CI、アテステーション権限 |

Renovateの生成処理が一時的に失敗した場合は、対象PRの最新コミットに対応するUpdate dependency artifactsの実行を確認し、`gh run rerun <run-id> --failed`で再実行します。宣言やmainとの競合が原因なら先に修正し、PR本文のrebase/retryチェックボックスでRenovateに更新を依頼します。補助コミット後の最新SHAで`required`が成功するまでマージしません。Vitestのメジャー変更や公開済みLua rockのハッシュ変化は、再実行で回避せず手動レビューします。

失敗を再実行する前に、同じコミットでローカルの`pnpm vp run ci`を実行します。外部サービスの一時障害と判断できる場合だけGitHub Actionsの再実行を使い、再現する失敗は修正PRで扱います。
