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
python3 contrib/wn7t94xr/ipk-selfcheck.py ./dist/wn7t94xr /tmp/wn7-base-cache
```

準備・起動用の2個と、RAMに展開するQSDK対応6個の、計8個の自作IPKを生成します。変更のない11個のIPKは公式リポジトリから取得し、GitHubには再配布しません。QSDK対応は `luci-mod-network`、iwinfoのライブラリとLua/RPCモジュール、`rpcd-mod-luci`、netifdプラグインに含みます。純正rpcd本体は使い続けます。

機種・認証・容量の検査は専用の `luci-qsdk-wn7t94xr-prepare` に含めています。iwinfoのIPKは標準のライブラリパッケージです。準備IPKは署名検証用の公開鍵とフィード設定も登録します。フィードを公開する際は `usign -S -m Packages -s <秘密鍵> -x Packages.sig` で署名してください。秘密鍵は配布物に含めません。

## RAMとoverlayの配置

`luci-base`、Network・Wireless・Software画面、Bootstrapテーマ、依存ライブラリ、uhttpd、QSDK連携の17個のIPKを、毎回の起動時にRAMへ取得します。各IPKのSHA-256とパッケージ名・バージョンを確認し、標準の `data.tar.gz` を展開します。別形式への再圧縮や、overlayへのダウンロード保存は行いません。

| 内容 | 保存先 |
| --- | --- |
| 起動処理、取得先とSHA-256の一覧、LuCI設定、フィード設定 | overlay |
| 公式の11個のIPK | 公式アーカイブからRAMへ取得 |
| QSDK対応の6個のIPK | このフォークのGitHub ReleaseからRAMへ取得 |
| 展開したLuCI、ライブラリ、uhttpd、QSDK連携 | `/tmp/luci-ram` |
| 取得したIPKと展開途中のファイル | 展開後に削除 |
| 後からopkgで追加した拡張や変更 | `/overlay/luci-ram/upper` |

`luci-ram` はネットワーク起動後の `START=95` で全てを取得します。取得制限は各IPKにつき45秒です。全ての取得・検証・展開が終わるまで純正サービスやマウント構成は変更しません。取得に失敗した場合はLuCIを起動せず、純正のルーター機能とSSHは起動を続けます。オンライン復帰後は `/etc/init.d/luci-ram start` で再試行できます。同じ起動中に取得済みの場合は再ダウンロードしません。

取得成功後はOverlayFSでLua、RPC、opkg管理情報、共有データ、Webファイル、netifdプラグインのディレクトリにRAM上のファイルを重ねます。ネットワーク起動処理、`/sbin/wifi`、iwinfoのライブラリはbind mountし、新規の実行ファイルとライブラリにはRAMを参照するシンボリックリンクを使います。純正領域のドライバー、ファームウェア、校正データは維持します。netifdはプロセス起動時にドライバープラグインを検出するため、RAMへの展開後にネットワーク管理サービスを一度再起動します。この際、通信が一時的に切れます。

17個の実行用パッケージの管理情報もRAMに生成するため、Software画面に表示され、opkgが依存関係を解決できます。後から追加した拡張の書き込み先はoverlayです。標準構成には追加拡張を保存せず、次回起動時に取得するファイルをRAMだけに配置します。`/etc/rc.local` にLuCIの起動処理を書く必要はありません。

## インストール

純正v2.5.1、rootシェル、インターネット接続が必要です。LuCIの事前インストールは不要です。有効なRPCdログイン設定を維持し、未設定の場合はOSのrootパスワードを使うログイン設定を作ります。rootパスワードが無効な場合は先に設定してください。認証情報や機器固有の校正データは配布物に含めません。

次の手順で永続領域に入るパッケージは、準備パッケージと起動パッケージの2個だけです。必要な実行用IPKは起動処理が取得します。最初のIPKをSHA-256で確認し、以後はopkgがフィードの署名とIPKのハッシュを検証します。

```sh
set -e
wn7_install_dir="$(mktemp -d /tmp/wn7-luci.XXXXXX)"
cd "$wn7_install_dir"
wn7_release=https://github.com/onokatio/luci/releases/download/v3.3.0-1
wn7_prepare=luci-qsdk-wn7t94xr-prepare_3.3.0-1_arm_cortex-a7_neon-vfpv4.ipk
curl -fL "$wn7_release/$wn7_prepare" -o "$wn7_prepare"
curl -fL "$wn7_release/SHA256SUMS" -o SHA256SUMS
awk -v name="$wn7_prepare" '$2 == name' SHA256SUMS > prepare.sha256
test "$(wc -l < prepare.sha256)" -eq 1
sha256sum -c prepare.sha256
opkg --force-space install "./$wn7_prepare"
opkg update
opkg --force-space install luci-qsdk-wn7t94xr
/etc/init.d/luci-ram start
```

[リリース](https://github.com/onokatio/luci/releases/tag/v3.3.0-1)のIPKには取得先とSHA-256を固定した一覧が入っています。公式IPKは[OpenWrtの公式アーカイブ](https://archive.openwrt.org/releases/packages-19.07/arm_cortex-a7_neon-vfpv4/)から取得します。準備パッケージは純正のネットワーク・無線制御の入口とログイン設定、起動パッケージ用の空き容量を検査します。未知の変更や容量不足では停止します。Dropbearの導入と設定は別途必要です。

v3.2.1以前の依存パッケージをoverlayへ入れた構成は、そのまま上書きできません。既存の設定とoverlayをPCへバックアップし、LuCI用の追加パッケージを削除し、置き換えたiwinfoの3パッケージをROM版へ戻してから移行してください。旧 `luci-base-ram` や `/overlay/luci-base` が残っている場合は、準備処理が停止します。純正の設定、SSH、無線の校正データは削除対象にしません。

この機器のopkgでは `--force-reinstall` を使わないでください。ROMにある他のパッケージのファイル一覧までoverlayへ複製し、容量を使い切る挙動を確認しました。更新時も通常の `install` を使います。

`opkg remove luci-qsdk-wn7t94xr` はLuCIを停止し、RAMのマウントを解除して純正のネットワーク起動処理を使う状態へ戻します。準備パッケージと設定、後から追加した拡張は自動では削除しません。
