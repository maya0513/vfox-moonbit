# vfox-moonbit

[English](README.md)

[vfox](https://vfox.dev/) 単体と mise の traditional vfox backend の両方で使える、
最新版の安定版 [MoonBit](https://www.moonbitlang.com/) 用プラグインです。

MoonBit はまだ 1.0 未満であるため、公開するチャンネルは意図的に `latest` 一つだけです。
過去版一覧、nightly/dev、範囲指定、部分バージョンは提供しません。インストール時に
`latest` を `0.x.y+build-id` 形式の完全版へ解決し、mise の lock と再試行に限って
その完全版も受け付けます。

## mise で使う

Git を先に `PATH` へ用意し、`mise.toml` に次を記載します。

```toml
[tools]
"vfox:maya0513/vfox-moonbit" = "latest"
```

```shell
mise install
mise exec -- moon version --all --json --no-path
```

CI で現在実動作を確認する基準版は mise 2026.9.2 です。これは上限ではなく、以降の
mise も動作する想定です。開発 tool 更新時に CI の確認版も最新版へ追随させます。

## standalone vfox で使う

public registry 採用前は Release の ZIP を直接追加します。`0.1.0` は現在の
プラグイン版へ置き換えてください。

```shell
vfox add --source https://github.com/maya0513/vfox-moonbit/releases/download/v0.1.0/vfox-moonbit-0.1.0.zip moonbit
vfox install --yes moonbit@latest
vfox exec moonbit@latest -- moon version --all --json --no-path
```

CI で現在実動作を確認する基準版は vfox 1.0.12 です。これは上限ではなく、以降の
互換性がある vfox も動作する想定です。

## インストールの仕組み

MoonBit の toolchain 本体と同時リリースされる `core` 標準ライブラリを一組として
扱います。

- 本体は MoonBit 公式 CDN と公式 SHA-256 のみを使います。
- updater は latest と exact の core が同一内容であることを確認し、SHA-256 を
  immutable な exact manifest に記録します。
- インストール時は exact manifest を再取得し、core を `.part` に保存して hash を
  検証してから展開します。`core/moon.mod` の版も完全一致させ、公式 installer と
  同じ二つの bundle コマンドを実行します。
- `PATH` は `<install-root>/shims`、`<install-root>/bin` の順に設定し、不変な
  toolchain と core は `MOON_TOOLCHAIN_ROOT=<install-root>` で選択します。
- 可変なユーザー状態の `MOON_HOME` は上書きしません。現行バイナリがcore探索に
  まだ必要とするため、`moon-lsp` と `moon-ide` の互換shim内だけでinstall rootを
  `MOON_HOME` に設定します。

MoonBit のバイナリはこのリポジトリで再配布・ミラーしません。過去の exact manifest
は残しますが、公式 CDN から削除された版の再インストールまでは保証できません。

moonup は設計上の参考に限定しています。実行ファイル、API、`setup-moonup`、
`moonbit-version`、`moonbit-binaries`、配布サービスは一切使いません。

## 対応環境

| ホスト | 本体 | core |
| --- | --- | --- |
| Linux x86_64、glibc | `tar.gz` | `tar.gz` |
| Linux arm64、glibc | `tar.gz` | `tar.gz` |
| macOS arm64 | `tar.gz` | `tar.gz` |
| Windows x86_64 | `zip` | `zip` |

macOS Intel、Windows ARM64 emulation、32-bit、musl/Alpine、その他 OS は明示的に
拒否します。NixOS は `nix-ld` などで公式 glibc ELF を実行できる環境に限る
best-effort で、正式なテスト対象ではありません。

MoonBit が利用する Git は必須です。native target で必要になる platform 固有の
tool や library はこのプラグインの管理対象外です。Windows のインストール処理は、
path を安全に扱うため OS 標準の Windows PowerShell（`powershell.exe`）を使います。

## 認証、状態、IDE

プラグインのインストーラーは `~/.moon`、shell 設定、認証情報に触れません。認証、
package index、cache は通常の可変な `MOON_HOME`（未指定時は `~/.moon`）を使うため、
mise/vfox でtoolchainを更新しても保持されます。利用者が設定済みの `MOON_HOME` も
上書きしません。

`MOON_TOOLCHAIN_ROOT` とhelper shimによりLSPとCLIが同じtoolchain/coreを参照するよう、
IDEも管理環境から起動します。

```shell
mise exec -- code .
# または vfox activate 済み shell から
code .
```

管理下のファイルを直接書き換える `moon upgrade` は使わず、mise/vfox から更新して
ください。

## 最新版の反映と cache

updater は 6 時間ごとに確認し、全対応 platform の公開が完了して整合するまで昇格
しません。vfox の Available cache は既定で最大 12 時間なので、upstream の公開完了
から通常は約 18 時間 + CI 時間が反映目標です。

すぐに再取得したい場合は次を実行します。

```shell
mise cache clear
vfox config cache.availableHookDuration 0
vfox search moonbit
```

確認後は vfox の既定値へ戻せます。

```shell
vfox config cache.availableHookDuration 12h
```

## 開発

開発 tool は `mise.toml`、`mise.lock`、`uv.lock`、`lua-rocks.lock` に固定します。

```shell
mise install
mise run bootstrap
mise run ci
mise run e2e
```

`mise run ci` は format、lint、workflow security、Lua 5.1 unit test、manifest、
line/branch coverage を検査します。GitHub Actions の実 E2E は全対応ホストで mise と
standalone vfox の両方を検証します。詳しくは [CONTRIBUTING.md](CONTRIBUTING.md) と
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) を参照してください。

## License

プラグインは Apache-2.0 です。MoonBit 本体は公式配布元から直接取得し、この
リポジトリでは再配布・再ライセンスしません。vendor した MIT component は
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) に記載しています。
