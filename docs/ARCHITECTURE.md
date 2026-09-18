# アーキテクチャ

この文書は現在の実装とtestが保証する契約を説明します。設計変更時は実装とtestを先に
確定し、その結果に合わせて更新します。

## 公開契約

vfoxへ公開するchannelは`latest`一件だけです。`Available`は
`releases/latest.json`を取得し、`0.x.y+build-id`形式の完全版を返します。
`PreInstall`は`latest`または完全版だけを受け付け、対応するimmutable manifestから
公式toolchainのURLとSHA-256を返します。

schema 1のexact manifestは`schema`、`recipe`、`version`と次のplatform recordを持ちます。

- `linux-x86_64`
- `linux-aarch64`
- `darwin-aarch64`
- `windows-x86_64`

各recordは`toolchain`と`core`の`url`、`sha256`、`format`を持ちます。HTTP path上の`+`は
`%2B`へencodeします。既存のexact manifestは変更しません。schemaはmetadata互換性、
recipeはbundleやlayoutを含むinstallation方式の互換性を表します。

## Plugin runtime

配布物はLua 5.1で実行されます。hookは薄く保ち、`lib/moonbit_*.lua`を次の責務へ分けます。

| Module | 責務 |
| --- | --- |
| `moonbit_manifest` | latest/exact取得、version、schema、canonical CDN URLの検証 |
| `moonbit_platform` | vfox/mise context、OS/arch alias、path、対応hostの正規化 |
| `moonbit_encoding` | UTF-16LE、Base64、PowerShell encoded command |
| `moonbit_process` | shell quoting、Lua 5.1/5.4の終了値、commandと安全なfilesystem操作 |
| `moonbit_runtime` | platform/process/encodingをまとめるruntime adapter facade |
| `moonbit_files` | streaming copy、比較、atomic shim用I/O、`moon.mod`読取 |
| `moonbit_core` | core検証とpromote/commit/rollback transaction |
| `moonbit_prepare` | permission、bundle、`moonx`、LSP/IDE shim |
| `moonbit_toolchain` | toolchain検証とcore preparationの処理順序 |
| `moonbit_installer` | download、hash、extract、cleanupを含むPostInstall全体 |

runtime facadeを残すことで、vfox objectの差分と依存注入を一か所に閉じ込めています。
Windowsのfilesystem操作とbundleはUTF-16LE/Base64のPowerShell `-EncodedCommand`で実行し、
外側の`cmd.exe`にpathを露出させません。

## インストールtransaction

1. `PostInstall`がresolved exact version、host、Git、toolchain layoutを検証します。
2. latestではなくexact manifestを再取得します。PreInstall後にlatestが進んでも、toolchainと
   coreは混ざりません。
3. coreをinstall root内の`.part`へdownloadし、pure Lua SHA-256で検証します。
4. 検証済みarchiveだけをstageへ展開し、vfoxとmiseのroot stripping差を二つの既知layoutへ
   正規化します。
5. `moon.mod`のversionと`builtin/moon.pkg`を検証し、既存coreをbackupしてstageを昇格します。
6. permission、bundle、`moonx`、helper shimを準備します。一つでも失敗すれば新しいcoreを
   quarantineし、以前のcoreをrestoreします。
7. 成功後にbackup、stage、archive、一時bundle homeを削除します。

Lua 5.1はyield境界に制約があるため、yieldし得るHTTP downloadとarchiver呼び出しは
`pcall`の外に置きます。cleanup対象はinstall root内の`.vfox-moonbit-*`へ限定し、広いpathの
再帰削除を拒否します。

## Environment contract

`EnvKeys`は`PATH=<root>/shims`、`PATH=<root>/bin`、
`MOON_TOOLCHAIN_ROOT=<root>`を返します。可変な`MOON_HOME`は呼び出し元の所有物であり、
hookは上書きしません。

現在のnative `moon-lsp`と`moon-ide`だけはcore探索に`MOON_HOME`も必要とするため、shimが
helper process内で両変数をinstall rootへ設定します。bundleでは認証やregistryへ触れない
一時homeを使います。

Unixの`moonx`は`moon`への相対symlinkです。Windowsはhardlinkを試し、失敗した場合だけ
streaming copyを行ってbyte一致を検証します。

## Updaterと信頼境界

TypeScript updaterはarchiveを実行しません。download中にsizeとSHA-256を計算し、一時fileを
必ずcleanupします。tar/ZIPの全memberを展開せずに走査し、絶対path、`..`、link escape、
special file、暗号化ZIP、CRC不一致、大小文字衝突、member数、展開後size、必須layoutを
検査します。

全platformを取得した後にlatestを再確認し、rollout競合を検出します。部分公開は正常延期、
installer/layout/version schema/MoonBit 1.0 driftはmanual review、その他はerrorです。CLIの
終了codeは順に0、2、1です。

scheduled workflowは6時間ごとにGitHub App tokenで`releases/**`だけを変更するPRを作り、
required CI後にauto-mergeします。mainへ直接pushせず、既存exact manifestの変更を拒否します。

## 保守tooling

Node 24のnative TypeScript CLIをVite+から実行します。Vite Taskはformat、lint、unit、coverage、
documentation、manifest、packageの依存graphとcontent cacheを管理します。sourceだけをcache
fingerprintへ含め、coverageと`dist`だけを復元します。networkと利用者stateへ依存するE2E、
upstream discovery、release操作はcacheしません。

miseはNode、pnpm、Lua、LuaRocks、workflow検査toolをlockし、`mise run`の公開入口から
Vite Taskへ委譲します。repository checkerはowner、dependency pin、workflow pin、manifest、
禁止されたPython残骸を検証し、documentation checkerは版、command、platform、環境変数、
local linkを実装と照合します。

## moonbit-overlayとの境界

比較対象は[`moonbit-community/moonbit-overlay` commit `831fa47`](https://github.com/moonbit-community/moonbit-overlay/tree/831fa47147eb8b9878b61d5d658102a699d8ea6b)です。

| 観点 | vfox-moonbit | moonbit-overlay |
| --- | --- | --- |
| Manager | mise / standalone vfox | Nix flake / overlay |
| Version | stable `latest`とlock用exact | latest、nightly、過去version |
| Source | 公式CDN、再配布なし | fixed archiveをReleaseへmirror |
| Install | 可変install rootへのrollback可能なtransaction | immutable Nix storeの`symlinkJoin` |
| User state | `MOON_HOME`を呼び出し元に維持 | wrapper/builderの用途に応じて設定 |
| Linux | 公式ELFを変更しない | `autoPatchelfHook`と`tinycc`置換 |
| Project build | toolchainだけ | `buildMoonPackage`とregistry cache |

Nix固有patch、artifact mirror、nightly、過去版一覧、project builder、LLVM追加bundleは
このpluginの対象外です。moonupについてもversion manager、shim、独自配布serviceを利用せず、
mise/vfoxと小さなmanifestが必要な責務を担います。
