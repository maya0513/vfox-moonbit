# リポジトリ設定

このファイルには、リポジトリ内のファイルだけでは強制できない設定を記録します。
定期更新を有効にする前、または最初の release を作成する前に設定してください。

## リポジトリ

- リポジトリは public な `maya0513/vfox-moonbit`、default branch は `main` とします。
- pull request の auto-merge と squash merge を有効にし、merge commit は無効にします。
- private vulnerability reporting を有効にします。
- このリポジトリで Actions を許可します。workflow 内の外部 action はすべて完全な
  commit SHA に固定します。

## main ruleset

GitHub App に bypass を与えず、`main` を対象とする ruleset を作成します。

- pull request を必須にする。
- conversation の解決を必須にする。
- 対象 path が変更された場合は CODEOWNERS の approval を必須にする。
- `quality`、現在の baseline に対する mise lock の検証、すべての mise / vfox E2E job
  に依存する、安定した集約 check `required` を必須にする。
- merge 前に branch が最新であることを必須にする。
- force push と削除を禁止する。
- squash merge だけを許可する。

意図的に `releases/**` を CODEOWNERS の対象にしていません。この manifest だけを変更する
bot PR は full CI を通過すると auto-merge できます。runtime code、実行可能 script、
workflow、schema / recipe の入力、dependency lock の変更には `@maya0513` が必要です。

## MoonBit updater 用 GitHub App

このリポジトリ専用の GitHub App を作成し、このリポジトリだけにインストールします。
次の権限だけを与えます。

- Metadata: read（必須の基本権限）
- Contents: read and write
- Pull requests: read and write

bypass 権限は与えません。公開情報である Client ID は Actions の repository variable として
保存します。

- `MOONBIT_UPDATER_CLIENT_ID`

private key だけを Actions secret として保存します。

- `MOONBIT_UPDATER_PRIVATE_KEY`

通常の `GITHUB_TOKEN` が作成、更新した pull request の後続 workflow は手動承認待ちになるため、
更新 workflow は CI を自動起動できるよう、bot branch と pull request にこの App の installation token を使います。
workflow 単位の `GITHUB_TOKEN` には障害報告のための Issues write だけを与え、App 自体には
Issue 権限を与えません。commit には実際の App slug と GitHub bot user ID を使用し、
未検証の固定 identity ではなく App の commit として GitHub に帰属させます。

updater は6時間ごと、および手動実行時に動作します。force-update の対象は
`automation/moonbit-latest` だけであり、`main` には直接 push しません。PR は常に1件に
保ち、squash auto-merge を有効にして、`releases/**` 以外の diff を拒否します。hard failure
が3回連続すると、重複しない issue を1件作成します。部分公開が連続した状態は小さな
workflow artifact で引き継ぎ、24時間経過すると重複しない停滞 issue を1件作成します。
recipe、layout、version schema、major version の drift を検出した場合は、直ちに重複しない
issue と、CODEOWNERS の review が必要で auto-merge されない
`automation/moonbit-manual-review` PR を作成します。

pull request の CI は `releases/**` を base commit と比較します。新しい exact manifest と
更新された `latest.json` pointer は許可しますが、base branch にすでに存在する exact
manifest の変更、削除、名前変更はすべて拒否します。

## リリース

`v*` に一致する tag を保護します。一致する SemVer tag では deterministic な full CI を
実行してから、次を公開します。

- `vfox-moonbit-X.Y.Z.zip`
- `vfox-moonbit-X.Y.Z.zip.sha256`
- GitHub artifact attestation
- 移動可能な `manifest` release 上の `manifest.json`

tag version は `PLUGIN.version` と一致しなければなりません。MoonBit manifest の更新だけでは
plugin release を作成しません。最初の stable release が成功した後に、manifest URL と
現在の完全な test version を vfox public registry へ提出します。
