# WN-7T94XR の QSDK Wireless 対応

I-O DATA WN-7T94XR の純正ファームウェア v2.5.1 で、LuCI 19.07 の標準 Wireless 画面を使うための実装です。無線ドライバー、ファームウェア、校正データは本体のものを使います。

実装は次のフォークで管理しています。

| フォーク | 変更内容 |
| --- | --- |
| [netifd / qsdk-legacy](https://github.com/onokatio/netifd/tree/qsdk-legacy) | 標準の wireless driver プラグイン。純正の制御処理を呼び、無線インターフェースの状態とブリッジへの接続を netifd に通知します。 |
| [iwinfo / qsdk](https://github.com/onokatio/iwinfo/tree/qsdk) | QSDK のラジオ名と VAP の対応、HE/EHT の機能情報、6 GHz のチャンネル、hostapd の暗号化情報、純正の WEXT スキャンに対応します。 |
| [LuCI / qsdk-wn7t94xr](https://github.com/onokatio/luci/tree/qsdk-wn7t94xr) | `rpcd-mod-luci` の MLO と HE/EHT 対応、QSDK の UCI 形式に合わせた標準 Wireless フォーム、IPK のビルド処理を含みます。 |

状態の取得には `network.wireless`、`luci-rpc.getWirelessDevices`、`iwinfo` を使います。独自の状態 API や常駐デーモンは追加していません。`/lib/netifd/wireless/qcawificfg80211.sh` は netifd が読み込む標準形式のドライバープラグインです。

MLOを含む設定変更は、純正の制御処理でラジオ全体に適用します。同じ設定には、netifdから複数のsetup呼び出しが来ても適用を一度にまとめる処理があります。片方のラジオを停止した場合は、残る有効なラジオの再起動と共有MLDのブリッジ接続の復元も必要です。このため、単一ラジオの操作でもMLOグループの通信が一時的に切れることがあります。MLOのブリッジには `mld*` を接続し、LuCIには各リンクの `ath*` の情報を返します。

追加APのインターフェース名は、純正管理画面とEasyMeshが使う番号を避けて割り当てます。追加直後は無効にし、SSID・暗号化・パスワードを設定してから有効にできます。6 GHzとMLOの暗号化はSAEです。スキャンは有効なラジオで利用できますが、スキャン結果からのSTA接続は対象外です。

## IPK のビルド

Linux amd64 と OpenWrt 19.07.10 の ipq40xx SDK を使います。SDK はユーザー空間のモジュールをビルドするために使い、カーネルやファームウェアは置き換えません。

SDK のファイル名は `openwrt-sdk-19.07.10-ipq40xx-generic_gcc-7.5.0_musl_eabi.Linux-x86_64.tar.xz`、SHA-256 は `b7c5e68c3d327a91dc5761f2d56c20a41e6846f36727f2c675810466d83b7306` です。[公式アーカイブ](https://archive.openwrt.org/releases/19.07.10/targets/ipq40xx/generic/)から取得してください。

`sources.json` の `forks` に記載したコミットを使います。SDK の base フィードも同ファイルの `sdk_base` に固定し、`libubox ubus uci lua libnl-tiny rpcd` を登録してビルドします。ソースを保持するため `CONFIG_AUTOREMOVE` を無効にしてください。SDK は Python 2 を要求します。

```sh
node contrib/wn7t94xr/selfcheck.js
python3 ../netifd/contrib/qsdk/selfcheck.py
python3 ../iwinfo/tests/channel-selfcheck.py
sh contrib/wn7t94xr/build-native.sh /path/to/sdk ../iwinfo /tmp/wn7-native
python3 contrib/wn7t94xr/build-base.py /tmp/wn7-base-cache
python3 contrib/wn7t94xr/build-ipk.py /tmp/wn7-native ../netifd /tmp/wn7-base-cache ./dist/wn7t94xr
python3 contrib/wn7t94xr/ipk-selfcheck.py ./dist/wn7t94xr/*.ipk
```

17個の依存IPKと、チェックサム、インストール用のまとめたアーカイブを生成します。公式IPKは `sources.json` のバージョンとSHA-256に固定しています。QSDK対応を加えるのは `luci-mod-network`、iwinfoのライブラリとLua/RPCモジュール、`rpcd-mod-luci`、netifdプラグインです。対応するパッケージで純正のiwinfoモジュールを置き換え、純正rpcd本体は使い続けます。

## RAMとoverlayの配置

`luci-base` のコードは公式版を使います。RAMへ配置するために、このIPKだけインストール処理を変更しています。QSDKの機能変更は含みません。

| 内容 | 保存先 |
| --- | --- |
| 公式 `luci-base` の圧縮ファイル | インストール時に取得し、`/root/luci-base.tar.xz` へ保存 |
| 展開した `luci-base` のコード | `/tmp/luci-base` |
| 起動処理、LuCI設定、opkgのパッケージ情報 | 通常のoverlay |
| LuCIの依存ライブラリ、Wireless、Software、テーマ、QSDK対応 | overlay |
| 後からopkgで追加する拡張やLuCIファイルへの変更 | overlay |

圧縮ファイルは自作IPKにもインストール用アーカイブにも含めません。[公式IPKのデータをXZで再圧縮した公開ファイル](https://github.com/onokatio/luci/releases/tag/luci-base-19.07)をインストール時にダウンロードし、SHA-256を確認します。展開後のtarは公式IPKとバイト単位で一致し、圧縮ファイルは118,844バイトです。

`luci-base-ram` サービスが起動時に保存済みの圧縮ファイルを検証して展開します。再起動時のダウンロードはありません。展開に失敗するとLuCIを起動できませんが、SSHと純正サービスの起動は継続します。

LinuxのOverlayFSで `/usr/lib/lua`、`/usr/libexec/rpcd`、`/usr/share`、`/www` を重ねます。RAMのベースを読み取り用の層とし、既存ファイルも読み取り用の層に含めます。書き込み先はUBIFSの `/overlay/luci-base/upper` です。そのため、通常の `opkg install` で追加した拡張と、ベースファイルに加えた変更は再起動後も残ります。マウント用の `work` と拡張の保存先は、同じUBIFSに置きます。

`/etc/rc.local` のLuCI起動処理は不要です。以前の既知の `luci-ram` サービスと圧縮ファイルは、移行時にバックアップして回収します。

## インストール条件

純正v2.5.1、rootシェル、インターネット接続が必要です。LuCIの事前インストールは不要です。有効なRPCdログイン設定を維持し、未設定の場合はOSのrootパスワードを使うログイン設定を作ります。rootパスワードも無効な場合は、インストール前に設定してください。認証情報や機器固有の校正データは配布物に含めていません。

インストール処理はROMのネットワーク起動処理と無線制御の入口を確認し、未知の変更がある場合は停止します。機器の設定をバックアップしてから、[リリース](https://github.com/onokatio/luci/releases/tag/v3.1.0-1)のアーカイブを `/tmp` で展開してください。

```sh
set -e
wn7_install_dir="$(mktemp -d /tmp/wn7-luci.XXXXXX)"
cd "$wn7_install_dir"
curl -fL https://github.com/onokatio/luci/releases/download/v3.1.0-1/wn7t94xr-luci-3.1.0-1.tar.gz -o packages.tar.gz
tar -xzf packages.tar.gz
sha256sum -c SHA256SUMS
opkg --force-space install ./libiwinfo20181126_2019-10-16-07315b6f-1+qsdk3.1.0_arm_cortex-a7_neon-vfpv4.ipk && opkg --force-space install ./*.ipk
```

最初のIPKで機種・設定・容量を検査して移行を準備し、成功した場合に残りをインストールします。opkgは圧縮前の容量を積算するため、`--force-space` の指定が必要です。インストール前後にも独自の容量検査を行い、圧縮後の必要容量と32 KiBの空きを確保します。容量不足はエラーです。UBIFSでは書き込み直後に未圧縮の容量が予約され、空き容量表示が一時的に0になることがあります。

標準構成の必要容量の見積もりは約460 KiBです。既に同じパッケージが入っている場合はその分を差し引き、確認済みの旧RAM用ファイルも回収します。無線ファームウェア、ドライバー、校正データは削除しません。追加する拡張パッケージの容量は別途必要です。

この機器のopkgでは `--force-reinstall` を使わないでください。ROMにある他のパッケージのファイル一覧までoverlayへ複製し、容量を使い切る挙動を確認しました。更新時も上記の通常の `install` を使います。

インストール時にネットワーク管理サービスを再起動するため、通信が一時的に切れます。既存のSSH設定と `/etc/rc.local` は変更しません。エラー時の移行前ファイルは、再起動するまで `/tmp/luci-qsdk-install/previous.tar.gz` に残ります。容量不足やダウンロード失敗が出た場合は再起動せず、このバックアップをPCにも保存してください。

純正の `/etc/init.d/network` と `/sbin/wifi` をROMから再利用し、Wireless操作をnetifdに接続します。純正の無線制御スクリプトそのものは再配布していません。LuCIはTCP 8080で起動し、`http://<本体のIPアドレス>:8080/cgi-bin/luci/` でアクセスできます。

`opkg remove luci-qsdk-wn7t94xr` でQSDKのネットワーク起動処理と無線制御の入口をROM版へ戻します。別の依存パッケージは残ります。`luci-base` を削除する場合も、保存した拡張ファイルや圧縮ファイルは自動では削除しません。

他機種・他バージョンでの動作、STA 接続、EasyMesh の再構成、長時間の通信負荷は未検証です。適用前に本体の設定をバックアップしてください。

## 実機での確認

WN-7T94XR v2.5.1 で、標準 API による 3 ラジオの状態取得、2.4/5/6 GHz の暗号化 AP の追加・削除、標準 Scan 画面を確認しました。6 GHz は純正ライブラリでも検出 0 件でした。既存の 160/320 MHz 幅を維持し、テスト後に無線設定をバイト単位で復元しています。

片方のラジオの停止・復帰では、動作中の MLO リンクのブリッジ接続も確認しました。停止後の再接続は約 37 秒、復帰は約 44 秒、3 帯域の AP 追加は約 66 秒、削除は約 48 秒でした。

v3.1.0-1への移行、ベースのダウンロードとハッシュ検証、再起動後のLuCI自動起動を確認しました。通常のopkgで検証用のLuCI拡張を追加して変更し、再起動後も画面表示とLuaモジュールが残ることを確認しています。ベースファイルへの変更もUBIFSに残りました。検証用の拡張と変更は削除しています。

移行前後で、無線・ネットワーク設定、認証情報、SSH本体、校正データなど12ファイルが一致しました。未変更の新品への導入、長時間の通信負荷は未検証です。
