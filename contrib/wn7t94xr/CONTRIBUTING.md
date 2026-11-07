# WN-7T94XR の QSDK 対応へのコントリビュート

このフォークでは、WN-7T94XR の純正ファームウェア v2.5.1 上で標準の LuCI 25.12 を使えます。純正のドライバー、hostapd、rpcd・netifd 本体を使い、互換処理と追加の実行環境を IPK で提供します。実行環境は起動時に RAM へ展開します。全体の構成は [README の図](../../README.md#コンポーネントと呼び出し関係)、導入方法は [機種別ガイド](README.md) を参照してください。

## 変更を送る

1. QSDK 固有の変更は `onokatio/luci` をフォークし、`qsdk-25.12` から作業ブランチを切ります。PR のマージ先も `onokatio/luci:qsdk-25.12` を指定してください。公式 LuCI にも当てはまる変更は、[公式の投稿手順](../../CONTRIBUTING.md#patches-and-pull-requests)を参照してください。
2. PR には再現手順、期待した結果、実際の結果、変更するコンポーネント、確認できた範囲を書いてください。実機がなくても、再現テストや文書の改善は送れます。
3. 呼び出し経路、コンポーネント、RAM と overlay の配置、起動・停止・失敗時の動作を変えたら、同じ変更でルート README の図と説明を更新してください。

## どこを変更するか

| 症状や変更内容 | 最初に見る場所 |
| --- | --- |
| Wireless の項目、保存する UCI 値、MLO リンク間の設定同期 | [wireless.js](../../modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js) |
| LuCI に表示する無線・端末・チャンネル情報の補正 | [network.js](../../modules/luci-base/htdocs/luci-static/resources/network.js) と上記の Wireless 画面 |
| ドライバーからの無線・接続端末情報の取得 | [iwinfo フォーク](https://github.com/onokatio/iwinfo) |
| 無線の起動・停止、VAP・ブリッジの登録 | [netifd フォーク](https://github.com/onokatio/netifd)の `examples/wireless/qcawificfg80211.sh` と `contrib/qsdk/wifi` |
| 機能判定・Switch の RPC、端末切断 | [LuCI の ucode RPC](../../modules/luci-base/root/usr/share/rpcd/ucode/luci) と [qsdk-hostapd.c](qsdk-hostapd.c) |
| HTTP 経由の LuCI 要求、ログインや並列要求 | [dispatcher.uc](../../modules/luci-base/ucode/dispatcher.uc) と [実行環境のビルド](build-runtime.sh) |
| IPK の依存関係、ABI、ダウンロード・マウント、起動失敗からの復旧 | [sources.json](sources.json)、[build-native.sh](build-native.sh)、[build-ipk.py](build-ipk.py)、[luci-ram](root/etc/init.d/luci-ram) |

公式のフォーム、RPC、パッケージビルドで扱える処理は、既存の実装を使います。QSDK 固有の取得処理は iwinfo に、画面での設定変換は LuCI に置きます。公式の `rpcd-mod-iwinfo` と `rpcd-mod-luci` は無改変でビルドしています。netifd フォークから IPK に収録するのは無線プラグインと `/sbin/wifi` の処理です。

複数リポジトリにまたがる変更は、関連 PR を相互にリンクしてください。LuCI の CI は [sources.json](sources.json) の `forks` に記載したコミットを `onokatio/iwinfo` と `onokatio/netifd` から取得します。手元で試す場合は各フォークを LuCI の隣に配置し、変更したコミットを使ってビルドできます。LuCI 側で参照先を更新する場合は、CI が取得できるコミットを指定してください。

LuCI を更新するときの比較基点は `sources.json` の `luci_upstream` です。Wireless の保存・適用と RPC の入出力を先に確認し、公式側で同じ処理を扱えるようになった箇所は、動作を確認したうえで互換処理を取り除きます。ネイティブのモジュールを更新する場合は、旧 SDK でのビルドに加え、純正 rpcd に読み込まれることを確認してください。

## 実機なしで検証する

ルートディレクトリで次を実行します。JavaScript の検査では LuCI の実際のモジュールを読み込み、QSDK と標準 mac80211 の両方の動作を確認します。

```sh
node contrib/wn7t94xr/selfcheck.js
python3 contrib/wn7t94xr/sqm-selfcheck.py
```

無線プラグインを変更したら、netifd フォークを隣に置き、ルートディレクトリから `python3 ../netifd/contrib/qsdk/selfcheck.py` も実行します。ネイティブモジュールと IPK 全体の検証には Linux amd64、OpenWrt 19.07.10 SDK、QEMU を使います。準備と実行の手順は [QSDK の CI 定義](../../.github/workflows/qsdk.yml)と[機種別のビルド手順](README.md#ipk-のビルド)にあります。CI は ARM 用のテストを実行し、パッケージの依存関係、ABI、RAM 展開や失敗時の復旧も検査します。生成した IPK は Actions の `wn7t94xr-ipk` アーティファクトで取得できます。

CI の成果物では、起動用 IPK の取得先がバージョン番号に対応する GitHub Release に設定されています。実機向けの試験ビルドでは試験用のバージョンと配布先を使い、[build-ipk.py](build-ipk.py) の `FEED_URL` とフィードの検証鍵を合わせて IPK を生成してください。正式フィードへの署名と公開はメンテナーが行います。

## 実機で再現・確認する

最初に機種、純正ファームウェアと追加 IPK のバージョン、対象の帯域、MLO と個別 SSID の有効状態を控えます。設定変更を試す前に設定のバックアップを取り、通信が切れた場合の復旧経路を確保してください。

1. **画面と保存値を確認する。** LuCI で保存して編集画面を開き直し、適用前に再現するか確認します。適用後は `uci get wireless.<セクション>.<項目>` で保存値を確認します。純正 Web で設定を変えた後は、LuCI のページ全体を再読み込みしてください。
2. **実行時の状態を確認する。** `ubus call network.wireless status`、`/sys/class/net`、`logread`、対象 VAP の `hostapd_cli -p /var/run/hostapd-wifi<N> -i <VAP> status` を照合します。`<N>` は対象 VAP が属する無線機の番号です。netifd の `up` と、hostapd が `ENABLED` になって SSID が見える時点には差があります。広いチャンネル幅で DFS の待機が入る場合もあります。
3. **利用者から見た動作を確認する。** Wireless を変更したら対象 SSID へ再接続し、モバイル回線を切って通信できるか確かめます。純正 Web と共有する設定を変えた場合は、両方の画面からの適用を確認します。MLO に関わる変更では MLO のみと個別 SSID を併用した構成を分けて確認します。
4. **結果を区別して報告する。** CI の合否、画面操作、保存値、hostapd の状態、端末での通信、再起動後の結果は別々に記録してください。例えば、802.11k の設定が保存され、hostapd に反映されたことは、端末から測定応答を受け取ったこととは別の検証です。

起動の問題は `logread -e luci-ram` で、取得、検証、展開のどの段階で止まったかを確認します。起動処理を変更した場合は、取得失敗時にも純正のネットワークと SSH が使え、取得先への接続が回復した後に LuCI を起動できるかを確認してください。

設定や状態の出力には無線鍵、MAC アドレス、機器固有の情報が含まれることがあります。Issue や PR には必要な項目だけを抜き出し、認証情報や機器を特定できる値を伏せてください。

## 過去の不具合から分かったこと

| 症状 | 確認すること |
| --- | --- |
| LuCI で SSID を有効にすると純正 Web がエラーを出す | QSDK の純正 API が読む `disabled=0` が、公式フォームの既定値省略で消えていないか確認します。 |
| MLO の 802.11k が保存後に無効へ戻る | QSDK 向けの LuCI は `rrm_neighbor_report` と `rrm_beacon_report` の明示値から有効状態を判定します。保存後に対象 MLO の各リンクを確認してください。[v5.11.3-1](https://github.com/onokatio/luci/releases/tag/v5.11.3-1) では、LuCI の保存・適用後と純正 Web で個別 SSID を切り替えた後の設定保持、端末の通信を実機で確認しました。この修正の検証では、本体再起動後の保持と端末からの測定応答は未確認です。 |
| MLO と個別 SSID を併用すると無線が起動しない | netifd のログに `TXPOWER_CONFIGURATION_FAILED` が出たら、送信出力の未指定値を `0` に変換してドライバーへ書いていないか確認します。 |
