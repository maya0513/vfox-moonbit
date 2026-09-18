# vfox-moonbit

[English](README.md)

standalone vfox と mise の traditional vfox backend で使える、最新版の安定版
[MoonBit](https://www.moonbitlang.com/) toolchain用プラグインです。

MoonBitは1.0未満なので、公開channelは意図的に`latest`だけです。インストール時に
`0.x.y+build-id`形式の完全版へ解決し、その値はlockfileと再現可能な再試行に限って
受け付けます。過去版一覧、範囲、部分版、nightly、development channelは対象外です。

## インストール

Gitを先に`PATH`へ用意してください。

### mise

```toml
[tools]
"vfox:maya0513/vfox-moonbit" = "latest"
```

```shell
mise install
mise exec -- moon version --all --json --no-path
```

CIで現在確認しているmiseは2026.9.2です。互換性の下限や上限ではなく、定期的に
前進させる実動作確認版です。

### standalone vfox

public registry採用前はRelease archiveを直接追加します。

```shell
vfox add --source https://github.com/maya0513/vfox-moonbit/releases/download/v0.1.3/vfox-moonbit-0.1.3.zip moonbit
vfox install --yes moonbit@latest
vfox use moonbit@latest
moon version --all --json --no-path
```

CIで現在確認しているvfoxは1.0.12です。`install`と`use`は`latest`を解決しますが、
非対話の`vfox exec`にはインストール済みの完全版が必要です。

```shell
vfox exec moonbit@0.x.y+build-id -- moon version --all --json --no-path
```

Windowsでは最後のコマンドに`moon.exe`を使います。

## インストール契約

MoonBitが公開するplatform toolchainと対応する`core`標準ライブラリを、一つの検証済み
releaseとして扱います。

- toolchainは公式CDNとMoonBit公式SHA-256だけを使います。
- updaterはlatestとexactのcore archiveがbyte単位で一致した場合だけexact SHA-256を
  記録します。
- インストール時はimmutableなexact manifestを再取得し、coreを`.part`へdownloadして
  展開前に検証し、`core/moon.mod`も確認します。
- coreはtransactionとして昇格し、bundleまたはshim生成に失敗するとrollbackします。
- 公式installerと同じ二つのbundle commandを、隔離した一時homeで実行します。

リポジトリが保持するのはmanifestとplugin codeだけです。MoonBit archiveはmirrorも
再配布もしません。過去のexact manifestは残しますが、再インストールには対応する
公式CDN objectが必要です。

moonupは設計上の参考に限ります。実行ファイル、API、setup action、binary repository、
配布serviceは使いません。

## 対応host

| Host | Toolchain | Core |
| --- | --- | --- |
| Linux x86_64、glibc | `tar.gz` | `tar.gz` |
| Linux arm64、glibc | `tar.gz` | `tar.gz` |
| macOS arm64 | `tar.gz` | `tar.gz` |
| Windows x86_64 | `zip` | `zip` |

macOS Intel、Windows ARM64 emulation、32-bit、musl/Alpine、その他OSは拒否します。
NixOSは`nix-ld`などで公式のglibc-linked ELFを実行できる場合だけbest-effortです。

MoonBitのnative targetが必要とするplatform固有のtoolやlibraryは管理対象外です。
Windowsのインストールでは、pathを安全に扱うためOS標準のWindows PowerShellを使います。

## 環境変数と可変状態

| 値 | 挙動 |
| --- | --- |
| `PATH` | 選択したinstall rootの`shims`と`bin`を先頭へ追加します。 |
| `MOON_TOOLCHAIN_ROOT` | 選択したimmutableなtoolchainとcoreを指します。 |
| `MOON_HOME` | 呼び出し元が管理する可変状態で、pluginはexportしません。 |

現行の`moon-lsp`と`moon-ide`はcore探索に`MOON_HOME`も参照するため、compatibility shimが
そのprocessだけ上書きします。core bundleも隔離した一時値を使います。認証、package
index、cacheは通常の`MOON_HOME`（一般には`~/.moon`）に残り、toolchain更新後も維持されます。

editorは管理環境から起動してください。

```shell
mise exec -- code .
# またはvfox activate済みshellから
code .
```

管理下のinstallを直接変更する`moon upgrade`は使わず、miseまたはvfoxから更新します。

## 最新版とcache

updaterは6時間ごとに確認し、全対応platformで完全かつ整合するreleaseだけを昇格します。
vfoxのAvailable cacheは最大12時間なので、upstream公開完了から通常約18時間とCI時間が
反映目標です。

```shell
mise cache clear
vfox config cache.availableHookDuration 0
vfox search moonbit
vfox config cache.availableHookDuration 12h
```

## 開発

開発toolはmise、pnpm、LuaRocksでlockします。Vite+がcache付きtask graphを管理し、miseは
固定済み実行ファイルと安定した入口を提供します。

```shell
mise install
mise run bootstrap
mise run ci
mise run e2e
```

`mise run ci`はformat、lint、型、workflow、文書の実装整合、unit test、coverage、manifest、
deterministic packageを検査します。GitHub Actionsでは全対応hostについてmiseとstandalone
vfoxの実download E2Eも実行します。詳細は[CONTRIBUTING.md](CONTRIBUTING.md)と
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)を参照してください。

## License

pluginはApache-2.0です。MoonBitはpublisherから直接downloadし、ここでは再licenseしません。
vendorしたMIT codeは[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)に記載しています。
