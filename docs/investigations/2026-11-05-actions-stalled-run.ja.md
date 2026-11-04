# GitHub Actionsの完了状態が確定しない事象

2026年11月5日（日本時間）、共通pnpm待機ポリシーの移行PRで確認した記録です。GitHub内部の根本原因は未確定です。

## 対象と観測結果

- PR：<https://github.com/maya0513/vfox-moonbit/pull/70>
- head：`6d645098e1981a91179b992428c2b634ffcc4098`
- 実行：<https://github.com/maya0513/vfox-moonbit/actions/runs/41876467272>
- Windows vfoxジョブ：`126737094835`
- 集約ジョブ`required`：`126739056044`

Windowsジョブの全13ステップは成功していました。実ダウンロードE2Eは2026-11-04 17:22:34 UTC、最後の`Complete job`は17:22:37 UTC（日本時間11月5日02:22:37）に完了しています。一方でジョブは`in_progress`、実行全体と`required`は`queued`、実行全体の`conclusion`は`null`のままでした。

| 操作 | 結果 |
| --- | --- |
| RESTによる実行・ジョブの照会 | `queued`／`in_progress` |
| 新しいGraphQL queryによるheadのチェック照会 | Windowsが`IN_PROGRESS`、`required`が`QUEUED` |
| Cache-Controlと別query parameterを付けたREST照会 | 同じ状態 |
| force-cancel | HTTP 409、実行中ではないため停止できないという応答 |
| 通常cancel | 完了済みの実行は停止できないという応答 |
| failed jobsの再実行 | まだ実行中という応答 |

品質検査、依存生成物の検証、Linuxのmise／vfox E2E、Windowsのmise E2Eは確定した成功でした。Windowsのvfox E2Eもステップ単位では成功しており、アプリケーションの失敗を示すログはありませんでした。

## macOSの容量不足との区別

先行する実行`41870357117`では、macOSジョブにrunner取得失敗とhosted arm64の容量制約がGitHubのannotationとして記録されました。所有者の指示で`SKIP_MACOS_E2E=true`を設定し、今回の実行ではmacOSのジョブを生成していません。この容量不足と、Windowsの成功後に完了状態が確定しない事象が同じ原因かどうかは分かりません。

## 類似する一次報告

[Community #210234](https://github.com/orgs/community/discussions/210234)では、RESTはqueued、cancelはcompletedと応答し、force-cancelも失敗する状態が報告されています。報告者の環境では新しい実行は正常に動いていました。

[Community #205920](https://github.com/orgs/community/discussions/205920)にも、照会・停止・再実行の状態が食い違う報告があります。ただし、この例はジョブが0件の再実行であり、今回のように実行済みステップがある状態とは異なります。どちらの報告も、今回の内部原因を確定する証拠ではありません。

## 対応

この実行IDに対する停止・再実行の繰り返しを打ち切り、本記録を追加した新しいheadでCIを起動します。実装の変更や必須チェックの上書きは行わず、Linux x64／arm64・Windows x64のE2E、品質検査、依存生成物検証、`required`を新しいheadで確認します。

macOSの再開手順とmise準備ジョブの一時固定の解除条件は[CI文書](../CI.ja.md)に記録しています。
