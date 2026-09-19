# vfox-moonbit

[English](README.md)

[MoonBit](https://www.moonbitlang.com/) toolchainをmise(traditional vfox backend) またはstandalone vfoxから利用するためのプラグインです。

`latest`のみを提供します。

## インストール

### mise

```shell
mise use 'vfox:maya0513/vfox-moonbit@latest'
moon version
```

または、projectの`mise.toml`へ次の設定を追加してからインストールします。

```toml
[tools]
"vfox:maya0513/vfox-moonbit" = "latest"
```

```shell
mise install
moon version
```

CIで現在確認しているmiseは2026.9.2です。

### standalone vfox

GitHub Releaseからプラグインを追加します。

```shell
vfox add --source https://github.com/maya0513/vfox-moonbit/releases/download/v0.1.3/vfox-moonbit-0.1.3.zip moonbit
vfox install --yes moonbit@latest
vfox use moonbit@latest
moon version
```

CIで現在確認しているvfoxは1.0.12です。

## 対応host

| Host | Toolchain | Core |
| --- | --- | --- |
| Linux x86_64、glibc | `tar.gz` | `tar.gz` |
| Linux arm64、glibc | `tar.gz` | `tar.gz` |
| macOS arm64 | `tar.gz` | `tar.gz` |
| Windows x86_64 | `zip` | `zip` |

macOS Intel、Windows ARM64 emulation、32-bit、musl/Alpine、その他OSは拒否します。NixOSは`nix-ld`などで公式のglibc-linked ELFを実行できる場合だけbest-effortです。

MoonBitのnative targetが必要とするplatform固有のtoolやlibraryは管理対象外です。Windowsのインストールでは、pathを安全に扱うためOS標準のWindows PowerShellを使います。

## 環境変数と可変状態

| 値 | 挙動 |
| --- | --- |
| `PATH` | 選択したinstall rootの`shims`と`bin`を先頭へ追加します。 |
| `MOON_TOOLCHAIN_ROOT` | 選択したimmutableなtoolchainとcoreを指します。 |
| `MOON_HOME` | 呼び出し元が管理する可変状態で、pluginはexportしません。 |

現行の`moon-lsp`と`moon-ide`はcore探索に`MOON_HOME`も参照するため、compatibility shimがそのprocessだけ上書きします。core bundleも隔離した一時値を使います。認証、package index、cacheは通常の`MOON_HOME`（一般には`~/.moon`）に残り、toolchain更新後も維持されます。

## 最新版とcache

updaterは1日1回確認し、全対応platformで完全かつ整合するreleaseだけを昇格します。vfoxのAvailable cacheは最大12時間なので、upstream公開完了から通常最大約36時間とCI時間が反映目標です。

最新版が見つからない場合はcacheを更新できます。

```shell
mise cache clear
vfox config cache.availableHookDuration 0
vfox search moonbit
vfox config cache.availableHookDuration 12h
```

## License

本リポジトリのcodeはMIT Licenseです。MoonBit本体は公式配布元から直接downloadされ、本リポジトリのlicense対象には含まれません。第三者codeは[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)に記載しています。
