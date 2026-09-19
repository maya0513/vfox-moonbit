# アーキテクチャ

この文書では、現在の実装とテストで保証されている仕様を説明します。設計を変更する場合は、先に実装とテストを更新し、その結果をこの文書へ反映します。

## 公開契約

vfoxで提供するチャンネルは`latest`だけです。`Available`は`releases/latest.json`を取得し、`0.x.y+build-id`形式の完全なバージョン番号を返します。`PreInstall`は`latest`または完全なバージョン番号だけを受け付け、対応する固定済みのmanifestから公式toolchainのURLとSHA-256を返します。

完全なバージョン番号に対応するmanifestを、以下ではexact manifestと呼びます。schema version 1のexact manifestは`schema`、`recipe`、`version`と、次のplatformごとのrecordを持ちます。

- `linux-x86_64`
- `linux-aarch64`
- `darwin-aarch64`
- `windows-x86_64`

各recordには、`toolchain`と`core`それぞれの`url`、`sha256`、`format`を記録します。HTTP URLのpathに含まれる`+`は`%2B`へencodeします。既存のexact manifestは変更しません。schema versionはmanifest形式の互換性を、recipe versionはbundle手順やlayoutを含むインストール方式の互換性を表します。

## Plugin runtime

配布物はLua 5.1で実行されます。hookは薄く保ち、`lib/moonbit_*.lua`を次の責務へ分けます。

| Module | 責務 |
| --- | --- |
| `moonbit_manifest` | latest manifestとexact manifestの取得、version、schema、canonical CDN URLの検証 |
| `moonbit_platform` | vfox/miseの実行context、OS/arch alias、path、対応hostの正規化 |
| `moonbit_encoding` | UTF-16LE、Base64、PowerShell encoded command |
| `moonbit_process` | shell quoting、Lua 5.1/5.4の終了status、command実行、安全なfilesystem操作 |
| `moonbit_runtime` | platform、process、encodingを統合するruntime adapter |
| `moonbit_files` | streaming copy、byte比較、atomicなshim生成に使うI/O、`moon.mod`の読取 |
| `moonbit_core` | coreの検証と、昇格・確定・rollbackを行うtransaction |
| `moonbit_prepare` | permission、bundle、`moonx`、LSP/IDE shim |
| `moonbit_toolchain` | toolchainの検証後にcoreを準備する処理順序の制御 |
| `moonbit_installer` | downloadからcleanupまでを含む`PostInstall`全体 |

runtime adapterを介すことで、vfox objectの差分と依存注入を一か所に閉じ込めています。Windowsのfilesystem操作とbundleはUTF-16LE/Base64のPowerShell `-EncodedCommand`で実行し、pathをPowerShell内部で処理して`cmd.exe`のcommand lineから分離します。

## インストール処理

1. `PostInstall`が、`latest`から解決された完全なバージョン番号、host、Git、toolchainのlayoutを検証します。
2. そのversionに対応するexact manifestを再取得します。これにより、`PreInstall`の後に`latest`が更新されても、toolchainとcoreは同じversionに揃います。
3. coreのarchiveをinstall root内の`.part`へdownloadし、pure Lua SHA-256で検証します。
4. 検証済みのarchiveだけをstageへ展開し、vfoxとmiseで異なるarchive最上位directoryの扱いを、二つの既知のlayoutへ正規化します。
5. `moon.mod`のversionと`builtin/moon.pkg`を検証し、既存のcoreをbackupしてからstageを昇格します。
6. permission、bundle、`moonx`、helper shimを準備します。一つでも失敗した場合は新しいcoreを隔離し、以前のcoreを復元します。
7. 成功後にbackup、stage、archive、一時的なbundle用homeを削除します。

Lua 5.1では`pcall`をまたいでyieldできないため、yieldする可能性があるHTTP downloadとarchiverの呼び出しは`pcall`の外に置きます。cleanup対象はinstall root内の`.vfox-moonbit-*`に限定し、それより広いpathの再帰削除を拒否します。

## 環境変数

`EnvKeys`は`PATH=<root>/shims`、`PATH=<root>/bin`、`MOON_TOOLCHAIN_ROOT=<root>`を返します。可変状態を保持する`MOON_HOME`は呼び出し元が管理し、hookでは上書きしません。

現在のnative `moon-lsp`と`moon-ide`は、coreの探索に`MOON_HOME`も必要とします。この二つのcommandに限り、shimがhelper process内の`MOON_HOME`と`MOON_TOOLCHAIN_ROOT`をinstall rootへ設定します。bundleでは、認証情報やregistryから隔離した一時的なhomeを使います。

Unixの`moonx`は`moon`への相対symlinkです。Windowsではhardlinkの作成を試し、失敗した場合だけstreaming copyへ切り替えてbyte単位の一致を検証します。

## Updaterの信頼境界

TypeScript updaterはdownloadしたarchiveを検査だけに使用します。download中に受信sizeとSHA-256を計算し、処理に使った一時fileは必ずcleanupします。

tar/ZIPの全memberを展開せずに走査し、絶対path、`..`、展開先の外を指すlink、deviceやFIFOなどのspecial file、暗号化ZIP、CRC不一致、大小文字を区別しないfilesystemでの名前衝突、member数、展開後size、必須layoutを検査します。

全platformの成果物を取得した後に`latest`を再確認し、取得開始時のreleaseと一致することを検証します。結果とCLIの終了codeは次のとおりです。

| 状態 | 扱い | 終了code |
| --- | --- | --- |
| 一部のplatformが未公開 | 昇格せず、次回の実行まで延期 | `0` |
| installer、layout、version schema、MoonBit 1.0への変更を検出 | manual reviewを要求 | `2` |
| その他のerror | 実行失敗 | `1` |

scheduled GitHub Actions workflowは1日1回実行します。GitHub App tokenを使い、`releases/**`だけを変更するPRを作成して、required CIの成功後にauto-mergeします。`main`へは直接pushせず、既存のexact manifestに対する変更も拒否します。

## 開発・保守用ツール

保守用のTypeScript CLIは、Node 24の型除去機能により事前のtranspileなしで直接実行します。Vite Taskはformat、lint、unit test、coverage、documentation検査、manifest検査、package作成の実行順序とcacheを管理します。cache対象のtaskでは入力fileからfingerprintを算出し、coverage結果と`dist`のpackageを生成物として復元します。networkや利用者のstateへ依存するE2E、upstream discovery、release操作はcacheの対象外です。

miseはNode、pnpm、Lua、LuaRocks、workflow検査toolのversionを固定します。開発者向けの入口を`mise run`へ統一し、各taskの処理をVite Taskへ委譲します。repository checkerはowner、dependencyとworkflowのpin、manifest、禁止されたPython関連fileの残存を検証します。documentation checkerはversion、command、platform、環境変数、local linkの記述を実装と照合します。

## moonbit-overlayとの比較

比較対象は[`moonbit-community/moonbit-overlay` commit `edbca087`](https://github.com/moonbit-community/moonbit-overlay/tree/edbca0874797c2ee227d4f9cc2b427747756717c)です。

| 観点 | vfox-moonbit | moonbit-overlay |
| --- | --- | --- |
| 管理方法 | mise / standalone vfox | Nix flake / overlay |
| 環境の反映 | managerのshell activationまたはcommand環境で`EnvKeys`を反映 | dev shell、profile、wrapperで環境を反映 |
| version | stableの`latest`とlock用の完全なversion | latest、nightly、過去version |
| 配布元 | 公式CDNから直接取得し、再配布しない | hashを固定したarchiveをGitHub Releaseへmirror |
| インストール | 可変なinstall rootに対するrollback可能なtransaction | immutableなNix storeの`symlinkJoin` |
| 利用者のstate | 通常の`moon`では呼び出し元の`MOON_HOME`を維持 | 通常のbundleでは呼び出し元の`MOON_HOME`を維持 |
| LSP / IDE | helper shimだけ`MOON_HOME`と`MOON_TOOLCHAIN_ROOT`をinstall rootへ設定 | helper wrapperだけ両変数をNix store rootへ設定 |
| core bundle | 公式stable installerと同じ`--all`と`wasm-gc --quiet` | `--all`、`llvm`、`wasm-gc`を`--quiet`なしでbundle |
| `moonx` | Unixは相対symlink、Windowsはhardlinkまたは検証付きcopy | Unix packageで`moon`への相対symlink |
| Linux | 公式ELFを変更しない | `autoPatchelfHook`と`tinycc`置換 |
| project build | toolchainの提供のみ | `buildMoonPackage`とregistry cacheも提供 |

stable向けの[公式Unix installer](https://cli.moonbitlang.com/install/unix.sh)と[PowerShell installer](https://cli.moonbitlang.com/install/powershell.ps1)のbundle対象は`--all`と`wasm-gc`です。LLVM bundleはnightlyでのみ実行されます。そのため、[overlayの常時LLVM bundle](https://github.com/moonbit-community/moonbit-overlay/blob/edbca0874797c2ee227d4f9cc2b427747756717c/lib/bundle.nix)には揃えず、公式のstable recipeを優先します。

Nix固有のpatch、artifact mirror、nightly、過去versionの一覧、project builderは、このpluginの対象外です。

## 参考にした実装

設計にあたり、[moonup](https://github.com/chawyehsu/moonup)を参考実装として調査しました。moonupがtoolchainの取得、versionの選択、環境の切り替えを一体で提供するのに対し、このpluginではversionの選択と環境の切り替えをmise/vfoxに委ね、toolchainとcoreを整合する組み合わせで導入します。
