# アーキテクチャ

## 信頼モデルとバージョンモデル

公開チャンネルは `latest` だけですが、インストール時には必ず`0.x.y+build-id` 形式の 1.0 未満の完全なバージョンへ解決します。`releases/latest.json` は小さな可変ポインターで、`releases/<exact-version>.json` は変更しません。完全なバージョンはロックファイルと再試行のために存在し、過去バージョン一覧としては提供しません。

スキーマ 1 は `schema`、`recipe`、`version` と4プラットフォームのレコードで構成されます。各プラットフォームには `toolchain` と `core` オブジェクトがあり、それぞれが厳密に `url`、`sha256`、`format` を持ちます。CDN URL ではプラス記号を`%2B` にエンコードします。

対応するキーは次のとおりです。

- `linux-x86_64`
- `linux-aarch64`
- `darwin-aarch64`
- `windows-x86_64`

スキーマの変更はメタデータ互換性の変更を表します。レシピの変更は、bundleコマンドやレイアウトの変更など、インストール方式の意味的な変更を表します。どちらを変更する場合も、プラグインコードと同様のレビューが必要です。

## 実行時の流れ

1. `Available` が latest ポインターを取得し、完全なバージョンを1件返します。
2. `PreInstall` は `latest` または厳密な完全バージョンだけを受け付け、完全版のレコードとホストを検証してから、公式ツールチェインの URL と SHA-256 を返します。
3. vfox または mise がツールチェインをダウンロード、検証、展開します。
4. `PostInstall` が Git とツールチェインのレイアウトを確認し、完全版の manifestだけを再取得します。core を `.part` へダウンロードし、pure Lua 実装でハッシュを検証してからステージングディレクトリへ展開します。標準 Lua では固定した upstream 実装を使用し、GopherLua の標準と異なる代入動作には MIT ライセンスの小さな派生実装で対応します。
5. core の `moon.mod` にあるバージョンはツールチェインと完全に一致しなければなりません。ステージングした core を所定の位置へ移し、Unix では実行権限を補正したうえで、`MOON_TOOLCHAIN_ROOT` と一時的な `MOON_HOME` を指定して公式の2つの core bundle コマンドを実行します。失敗した場合は以前の core を復元します。
6. `moonx` と、互換性確保のための `moon-lsp` / `moon-ide` shim を作成します。
7. `EnvKeys` は shim とバイナリの各ディレクトリを `PATH` の先頭に追加し、
   `MOON_TOOLCHAIN_ROOT` を公開します。呼び出し元が管理する可変な `MOON_HOME` は
   意図的に変更しません。

Git は mise が管理する hook 依存関係（`depends`）と、ホストに必要な実行ファイル
（`systemDependencies`）の両方として宣言します。system dependency の事前検査に
対応していない古い runtime でも、`PostInstall` が同じく対処方法を示す明確なエラーを
返します。

検証済みの standalone runtime は vfox 1.0.12 で、プラグインの metadata もこの
バージョン以上を要求します。上限は設けません。互換性のある新しい vfox runtime は
動作する想定で、開発ツールの定期更新時に固定バージョンも更新します。プラグインが
未検証の外部アーカイブコマンドへフォールバックすることはありません。

runtime adapter は実際の vfox における展開結果と context の違いも正規化します。
standalone vfox はメイン SDK のルートを `ctx.sdkInfo.moonbit.path` で示し、アーカイブの
単一ルートディレクトリを取り除くことがあります。一方、mise はインストールルートを
直接渡し、`core/` を保持します。検証済みの `stage/core/moon.mod` または
`stage/moon.mod` というレイアウトだけを受け付けます。

Windows では GopherLua の `os.execute` がコマンドを `cmd.exe` 経由で起動するため、
引用符付きパスを含むコマンド文字列が2回目の解釈で壊れます。このため adapter は、
ファイル操作、hardlink、bundle の各処理を UTF-16LE/Base64 の PowerShell
`-EncodedCommand` で実行します。空白、Unicode、shell のメタ文字を含む場合も、
外側のコマンドラインにパスが現れることはありません。

mise と standalone vfox では追加アーカイブの扱いが異なっていたため、追加ファイル用
hook は使用しません。core のインストールは `PostInstall` 内の明示的な単一
transaction として実行します。

## moonbit-overlay との比較

後から overlay が変更されても表の内容が暗黙に不正確にならないよう、この比較は
[`moonbit-community/moonbit-overlay` の commit `831fa47`](https://github.com/moonbit-community/moonbit-overlay/tree/831fa47147eb8b9878b61d5d658102a699d8ea6b)
を基準にしています。

| 観点 | mise から利用する vfox-moonbit | moonbit-overlay |
| --- | --- | --- |
| 主な役割 | mise が選択、インストールする traditional vfox plugin。standalone vfox でも動作します。 | derivation、app、MoonBit project builder を公開する Nix flake / overlay。 |
| 公開バージョン | 安定版 `latest` のみ。upstream の完全なバージョンはロックファイルと再試行に限って受け付けます。 | 安定版 `latest`、rolling `nightly`、多数の過去バージョンの package attribute。 |
| バージョン識別子 | `0.x.y+build-id` のような upstream の toolchain / core の完全なバージョンを使用します。 | `v0.x.y+compiler-rev+moon-rev` のように compiler のバージョンへ `moon` の source revision を追加します。 |
| 成果物の取得元 | toolchain と core を MoonBit 公式 CDN からダウンロードし、どちらも再配布しません。 | 更新時には公式 rolling URL を使用し、固定した toolchain / core archive を overlay の GitHub Releases で公開します。nightly は公式 CDN のままです。 |
| 完全性と組み合わせ | 公式 toolchain の SHA-256、記録済み core の SHA-256、core metadata の完全一致、全対応ホストで単一のバージョンであることを検証します。 | 別々に取得した toolchain と core の derivation を Nix の fixed-output hash で検証し、選択した組み合わせを結合します。 |
| インストール方式 | manager の可変な install directory を transaction として構築し、core の反映に失敗した場合は rollback します。 | toolchain と core を `symlinkJoin` で合成し、immutable な Nix store の成果物にします。 |
| `MOON_TOOLCHAIN_ROOT` | 通常のコマンド向けに、選択した install root を公開します。 | 選択した Nix store の成果物として `moon` に wrapper で設定します。 |
| `MOON_HOME` | 呼び出し元が管理する可変な状態を維持します。`moon-lsp` と `moon-ide` の shim だけが、その process に限り install root を設定します。 | `moon` では呼び出し元が管理する状態を維持します。現在の `moon-lsp` と `moon-ide` の wrapper は両方の変数を store の成果物に設定します。 |
| `moonx` | Unix では相対 symlink、Windows では検証済みの hardlink またはコピーです。 | `moon` への相対 symlink です。 |
| core bundle | 公式 installer と同じ2つの bundle、`--all` と quiet な `--target wasm-gc` を実行します。 | `--all`、`--target llvm`、`--target wasm-gc` をすべて verbose で構築します。 |
| 現在のホストレコード | Linux x86_64/arm64 glibc、macOS arm64、Windows x86_64。 | 固定したレコードには現在 Linux x86_64 と macOS arm64 の hash があり、Nix target の対応には macOS x86_64 も含まれます。 |
| Linux 向け調整 | 公式 ELF payload は変更しません。NixOS は `nix-ld` または同等の仕組みによる best-effort 対応です。 | `autoPatchelfHook` を適用し、同梱の Linux `tcc` を nixpkgs の `tinycc` に置き換えます。 |
| project build | toolchain だけをインストールします。project build と registry は MoonBit / mise の利用者が管理します。 | `buildMoonPackage`、cache 済み registry の対応、完全な `MOON_HOME` を同梱する builder を提供します。 |
| 更新経路 | 6時間ごとの gate 付き bot PR。immutable manifest、archive safety、installer drift、required CI を検査してから自動 merge します。 | 日次 workflow が staged toolchain を取得して実行し、結合版のバージョンを算出します。version data を `master` へ push し、mirror release を作成します。 |

環境変数をこのように分けているのは意図的です。通常の `moon` コマンドには immutable な
toolchain を `MOON_TOOLCHAIN_ROOT` で渡し、現在の native helper には process-local な
shim で両方の変数を渡します。Nix 固有の patch、成果物の mirror、過去版 / nightly
channel、結合版のバージョン、project builder、LLVM bundle はこのプラグインの対象外です。

## 互換性の検証方針

CI は各対応ホストで、現在の mise 2026.9.2 と standalone vfox 1.0.12 をそれぞれ1つ
検証します。これらはある時点で動作を確認したバージョンであり、互換性の下限では
ありません。互換性のある新しい manager version は動作する想定で、開発ツールの
定期更新とともに固定バージョンも前進させます。古い manager version の維持に CI の
容量を使わない方針です。

## 自動昇格

updater は upstream data をダウンロードしますが、実行はしません。圧縮時と展開後の
size limit、member 数、正規化された相対 path、外部へ脱出しない link、device / special
file の不在、必須 layout、公式 toolchain checksum file、core の exact / latest が
byte 単位で一致すること、全 format が単一のバージョンであることを検証します。
すべての platform をダウンロードした後に latest を再確認し、rollout 中の競合を
検出します。

公式 Unix installer と PowerShell installer の digest、および既知の recipe marker は
別に固定しています。installer / layout の drift、新しい version schema、MoonBit 1.0
のいずれかを検出した場合は昇格を停止し、issue と CODEOWNERS による手動レビューが
必要な PR を作成します。platform の一部だけが公開されている場合は延期します。

latest-version bot が変更できるのは `releases/**` だけです。pull request の CI は
base commit と比較し、既存の exact manifest に対する変更を拒否します。それ以外の
path は CODEOWNERS と repository rules で保護します。

## moonup との境界

moonup は version 選択、shim、`moonbit-version`、成果物の配布を担います。これらの
責務は mise / vfox と、この小さな manifest がすでに担っています。moonup の executable、
API、setup action、binary repository、配布 endpoint は runtime にも updater にも
使用しません。
