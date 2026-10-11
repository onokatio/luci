# WN-7T94XR の QSDK Wireless 対応

I-O DATA WN-7T94XR の純正ファームウェア v2.5.1 で、LuCI 19.07 の標準 Wireless 画面を使うための実装です。無線ドライバー、ファームウェア、校正データは本体のものを使います。

実装は次のフォークで管理しています。

| フォーク | 変更内容 |
| --- | --- |
| [netifd / qsdk-legacy](https://github.com/onokatio/netifd/tree/qsdk-legacy) | 標準の wireless driver プラグイン。純正の制御処理を呼び、無線インターフェースの状態とブリッジへの接続を netifd に通知します。 |
| [iwinfo / qsdk](https://github.com/onokatio/iwinfo/tree/qsdk) | QSDK のラジオ名と VAP の対応、HE/EHT の機能情報、6 GHz のチャンネル、hostapd の暗号化情報、純正の WEXT スキャンに対応します。 |
| [LuCI / qsdk-wn7t94xr](https://github.com/onokatio/luci/tree/qsdk-wn7t94xr) | `rpcd-mod-luci` の MLO と HE/EHT 対応、QSDK の UCI 形式に合わせた標準 Wireless フォーム、IPK のビルド処理を含みます。 |

状態の取得には `network.wireless`、`luci-rpc.getWirelessDevices`、`iwinfo` を使います。独自の状態 API や常駐デーモンは追加していません。`/lib/netifd/wireless/qcawificfg80211.sh` は netifd が読み込む標準形式のドライバープラグインです。

MLO を含む設定変更は、純正の制御処理でラジオ全体に適用します。netifd から複数の setup 呼び出しが来ても、同じ設定は一度だけ適用します。片方のラジオを停止する場合は、残りの有効なラジオを再起動し、共有 MLD のブリッジ接続を復元します。このため、単一ラジオの操作でも MLO グループの通信が一時的に切れることがあります。MLO のブリッジには `mld*` を接続し、LuCI には各リンクの `ath*` の情報を返します。

追加 AP のインターフェース名は、純正管理画面と EasyMesh が使う番号を避けて割り当てます。追加直後は無効にし、SSID・暗号化・パスワードを設定してから有効にできます。6 GHz と MLO には SAE を使います。スキャンは有効なラジオで利用できますが、スキャン結果からの STA 接続は対象外です。

## IPK のビルド

Linux amd64 と OpenWrt 19.07.10 の ipq40xx SDK を使います。SDK はユーザー空間のモジュールをビルドするために使い、カーネルやファームウェアは置き換えません。

SDK のファイル名は `openwrt-sdk-19.07.10-ipq40xx-generic_gcc-7.5.0_musl_eabi.Linux-x86_64.tar.xz`、SHA-256 は `b7c5e68c3d327a91dc5761f2d56c20a41e6846f36727f2c675810466d83b7306` です。[公式アーカイブ](https://archive.openwrt.org/releases/19.07.10/targets/ipq40xx/generic/)から取得してください。

`sources.json` の `forks` に記載したコミットを使います。SDK の base フィードも同ファイルの `sdk_base` に固定し、`libubox ubus uci lua libnl-tiny rpcd` を登録してビルドします。ソースを保持するため `CONFIG_AUTOREMOVE` を無効にしてください。SDK は Python 2 を要求します。

```sh
node contrib/wn7t94xr/selfcheck.js
python3 ../netifd/contrib/qsdk/selfcheck.py
sh contrib/wn7t94xr/build-native.sh /path/to/sdk ../iwinfo /tmp/wn7-native
python3 contrib/wn7t94xr/build-ipk.py /tmp/wn7-native ../netifd ./dist/wn7t94xr
```

IPK は ARM 用の iwinfo ライブラリ、Lua/RPC モジュール、Wireless フォーム、netifd プラグインを含みます。ライブラリと LuCI は圧縮してフラッシュに保存し、起動時に RAM へ展開します。本体のライブラリは置き換えません。パッケージは XZ 圧縮したオーバーレイを保存します。

## インストール条件

純正 v2.5.1 と、既に導入した RAM LuCI のベースアーカイブが必要です。インストール処理は ROM のネットワーク起動処理、無線制御の入口、ベースアーカイブのハッシュを確認します。未知の変更がある場合は停止します。ベースアーカイブ、設定、認証情報はこのリポジトリに含めていません。

IPK を `/tmp` にコピーし、`opkg --force-space install /tmp/luci-qsdk-wn7t94xr_2.0.0-6_arm_cortex-a7_neon-vfpv4.ipk` を実行してください。既存の同名パッケージを更新します。opkg は更新前の圧縮アーカイブを空き容量に算入しないため、`--force-space` を指定します。IPK のインストール前処理で置換分を差し引いて容量を確認し、32 KiB の余裕を確保します。netifd プラグインを登録するため、ネットワーク管理サービスを再起動します。この間は通信が一時的に切れます。

純正の `/etc/init.d/network` と `/sbin/wifi` を ROM から再利用し、Wireless 操作を netifd に接続します。純正の無線制御スクリプトそのものは再配布していません。LuCI は起動時に RAM へ展開され、TCP 8080 で起動します。

`opkg remove luci-qsdk-wn7t94xr` で互換処理を削除し、ROM のネットワーク起動処理・無線制御の入口と RAM LuCI の起動処理を戻します。

他機種・他バージョンでの動作、STA 接続、EasyMesh の再構成、長時間の通信負荷は未検証です。適用前に本体の設定をバックアップしてください。

## 実機での確認

WN-7T94XR v2.5.1 で、標準 API による 3 ラジオの状態取得、2.4/5/6 GHz の暗号化 AP の追加・削除、標準 Scan 画面を確認しました。6 GHz は純正ライブラリでも検出 0 件でした。既存の 160/320 MHz 幅を維持し、テスト後に無線設定をバイト単位で復元しています。

片方のラジオの停止・復帰では、動作中の MLO リンクのブリッジ接続も確認しました。停止後の再接続と復帰はそれぞれ約 44 秒、3 帯域の AP 追加は約 66 秒、削除は約 48 秒でした。
