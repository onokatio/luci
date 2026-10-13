# WN-7T94XR の QSDK Wireless・Switch 対応

I-O DATA WN-7T94XR の純正ファームウェア v2.5.1 で、LuCI 19.07 の標準 Wireless・Switch 画面を使うための実装です。ドライバー、ファームウェア、校正データは本体のものを使います。

実装は次のフォークで管理しています。

| フォーク | 変更内容 |
| --- | --- |
| [netifd / qsdk-legacy](https://github.com/onokatio/netifd/tree/qsdk-legacy) | 標準の wireless driver プラグイン。純正の制御処理を呼び、無線インターフェースの状態とブリッジへの接続を netifd に通知します。 |
| [iwinfo / qsdk](https://github.com/onokatio/iwinfo/tree/qsdk) | QSDK のラジオ名と VAP の対応、HE/EHT の機能情報、6 GHz のチャンネル、hostapd の暗号化情報、純正の WEXT スキャンに対応します。 |
| [LuCI / qsdk-wn7t94xr](https://github.com/onokatio/luci/tree/qsdk-wn7t94xr) | `rpcd-mod-luci` の MLO・HE/EHT・Switch構成情報、QSDK の UCI 形式に合わせた標準 Wireless フォーム、IPK のビルド処理を含みます。 |

状態の取得には `network.wireless`、`luci-rpc.getWirelessDevices`、`iwinfo` を使います。独自の状態 API や常駐デーモンは追加していません。`/lib/netifd/wireless/qcawificfg80211.sh` は netifd が読み込む標準形式のドライバープラグインです。

MLOを含む設定変更は、純正の制御処理でラジオ全体に適用します。同じ設定には、netifdから複数のsetup呼び出しが来ても適用を一度にまとめる処理があります。片方のラジオを停止した場合は、残る有効なラジオの再起動と共有MLDのブリッジ接続の復元も必要です。このため、単一ラジオの操作でもMLOグループの通信が一時的に切れることがあります。MLOのブリッジには `mld*` を接続し、LuCIには各リンクの `ath*` の情報を返します。

追加APのインターフェース名は、純正管理画面とEasyMeshが使う番号を避けて割り当てます。追加直後は無効にし、SSID・暗号化・パスワードを設定してから有効にできます。有効なラジオではスキャンと、スキャン結果からのClient接続を使えます。通常のClientはブリッジに接続せず、独立したDHCPインターフェースに割り当てます。BSSID入力欄はClientだけに表示し、接続先の固定に使います。

## Wirelessの対応範囲

| 標準画面の機能 | QSDKへの反映 |
| --- | --- |
| AP追加・削除、スキャン、Client接続 | 純正制御処理とnetifdの標準インターフェースを使います。 |
| AP/ClientのWDS、Monitor | 純正ドライバーのモードとWDS設定を使います。MLOグループを作成し、別ラジオのリンクを追加できます。MLO Clientにも対応します。 |
| Legacy/N/AC/AX/BE、チャンネル、幅、国、送信出力 | ラジオの対応モードを取得し、QSDKのUCI形式へ保存します。送信出力の単位はdBmです。 |
| MAC許可・拒否リスト | 純正hostapdの標準ACLで判定します。追加APで正しく動かないドライバー側のACLは、競合を避けるため解除します。許可・拒否リストは設定ファイルとしてoverlayに保存し、ダウンロード失敗時にも純正hostapdが読める形式でUCIへ登録します。 |
| WMM、DTIM、ビーコン、RTS、プリアンブル、GTK更新、端末の無通信時間 | 純正の設定生成を使い、不足する標準項目はhostapdの起動前に補います。フラグメント閾値はLegacyモードで使えます。 |
| WPA2/SAE、OWE、EAP/RADIUS、PMF、802.11r、WPSの有効化 | 純正hostapd/wpa_supplicantの設定へ反映します。6 GHzとMLOではSAE、OWE、WPA3-EAPの強い暗号化を選びます。 |
| Associated Stations、Disconnect | iwinfoと標準の `hostapd.<ifname>.del_client` APIを使います。一時拒否は期限後に解除します。 |

純正ドライバーが公開しないAd-Hoc、802.11s、Distance Optimizationは表示しません。802.11rの実際のローミング、RADIUSサーバーとの認証、WDSのブリッジ通信には、対応する別のAPや認証サーバーが必要です。設定の反映・サービスの起動確認と、これらの相互接続確認は区別します。

Associated Stationsでは、純正 `wlanconfig` の端末一覧と、端末を指定したnl80211のGET_STATIONを合わせて取得します。一覧の取得が空でも、端末別のバイト数・パケット数・接続時間・認証状態を返せます。HE/EHT・帯域幅・NSSは純正の端末情報から取得します。接続モードの情報で、パケットごとの変動は表しません。送受信速度は、nl80211が不自然な値を返すため、純正一覧のMbps単位の値を使います。最新パケットのMCSやGIを取得できない場合は推測して表示しません。独立した取得スクリプトやデーモンは追加しません。

## Switch構成情報

純正の `/etc/board.json` にポート定義がないため、標準Switch画面は `has an unknown topology` と表示します。`rpcd-mod-luci` の標準API `luci-rpc.getBoardJSON` に、欠けている `switch1.ports` を補う処理を追加しました。既存のポート定義や、モデル・ネットワーク設定・他のSwitch情報は保持します。ファイルの書き換えや起動スクリプトの追加は行いません。

実行中のDTSがAP-MI01.6とQCA8386を示し、デバイス番号・CPU/LAN/WANのビットマップ・Ethernet1のエイリアスとdp2の接続属性が一致した場合だけ補完します。QSDKのeth1はsysfsではvirtualデバイスとして公開されるため、DTS側の対応情報を参照します。CPU側はポート0のeth1、外部ポートは1〜3です。10GbpsのWAN側eth0は、この外部Switchのポートには含めません。

筐体のLAN1・LAN2・LAN3が、それぞれSSDKのポート1・2・3に対応することを、実機のケーブル差し替えとリンク状態で確認しました。画面にもLAN1〜LAN3を表示します。リンク状態とVLAN機能の取得には、既存の標準RPCと純正 `swconfig` を使います。この追加処理はVLANの有効化や設定変更を行いません。VLANを編集する際は、CPUポートとLANインターフェースの対応を確認してください。VLAN機能を無効にする場合は、設定項目を削除せず `enable_vlan=0` を保存します。QSDKでは項目がないと有効な状態が残るため、標準フォームの保存処理を修正しました。

## フラグメント閾値と接続詳細

フラグメント閾値はLegacyモードのAPごとに反映し、同じラジオ内の別APへ上書きしません。256〜2346バイトの偶数を指定でき、空欄へ戻すと解除します。純正ドライバーはN・AC・AX・BEモードで従来のフラグメント閾値を反映しないため、そのモードでは入力値を保存できません。HEのフラグメント能力とは別の設定です。

Associated StationsのDetailsでは、接続時間、無通信時間、信号、RX/TXの速度・帯域幅・HE/EHT・MCS/NSS、通信量、パケット数、再送・失敗・破棄、認証・WMM・PMFの状態を表示します。RXは端末からルーターへの通信です。統計は純正ドライバーの報告値を使い、詳細画面も5秒間隔で更新します。切断された場合は、その状態を表示します。

QSDKが標準APIへ返さない認証状態と64ビットの通信量は、純正hostapdの制御ソケットから補います。MCSは標準のHE/EHT属性がある場合だけ表示し、速度から推定しません。ドライバーが報告しない項目は未取得として表示します。

Detailsを開いた端末では、純正 `/usr/sbin/wifitelemetry` から、RX/TX別のHT・VHT・HE・EHTのMCS使用回数とGI使用回数を取得します。GIは0.8・0.4・1.6・3.2 µsの分類です。使用分布は累積カウンターであり、最新パケットのMCS・GIを示しません。通常の接続一覧では、この追加取得を行いません。

RPCdのlibnl-tinyと純正Telemetryのlibnl-3は同じ関数名を使うため、純正ライブラリをRPCdへ直接読み込むと取得できません。既存の純正ツールを別プロセスで呼び出して競合を避け、AdvancedのGIとDebugのMCSを読み取ります。呼び出しは各1.5秒、出力は各32 KiBまでに制限し、指定したMACアドレスとインターフェースに一致する結果だけを使います。取得失敗では使用分布を未取得として表示し、未取得の値を0として扱いません。ツール自体と検証用の `telemetry-selfcheck` はIPKに含めません。

QSDKランタイムのバージョンごとにJavaScriptのキャッシュキーを更新するため、更新後は通常の再読み込みで新しい画面を取得できます。

EAP ClientはPEAP・TTLSの内部認証をwpa_supplicantの設定へ変換します。TTLSのEAP方式には `autheap=`、PEAPには `auth=` を使います。純正wpa_supplicantにFASTは組み込まれていないため、WN-7T94XRでは選択肢から外しています。

MLOはGeneral SetupのMulti-Link Operationでグループを作成・選択します。各ラジオを1リンクずつ、最大3リンク追加できます。全ラジオでBEモードを使い、Clientにはブリッジではないネットワークを割り当ててください。リンクを削除してグループが空になると、そのグループも削除します。MLO Clientの接続先にはMLOが有効なAPが必要です。

## アクセラレーション

Network → Accelerationで、純正ECMの有効・無効と加速エンジンを設定できます。WN-7T94XRではAuto、PPE、SFE、PPE＋SFEを選べます。搭載されていないNSSの選択肢は表示しません。設定は純正の`/etc/config/ecm`へ保存し、純正の`qca-nss-ecm restart`で反映します。適用時にECMを再読み込みするため、通信速度が一時的に低下する場合があります。適用に失敗した場合は元の設定へ戻して再読み込みを試みます。

標準RPCdモジュールの`luci-rpc.getAccelerationStatus`で、IPv4/IPv6・エンジン別の加速接続数、TCP/UDPの内訳、処理待ち数、PPEの資源・フロー・失敗統計、Wi-Fi Direct Switchの送受信パケット数を取得します。画面は5秒間隔で更新し、取得できない値は「-」で表示します。64ビットの累積カウンターは文字列で返し、JavaScriptでの丸めを避けます。

純正ドライバーと起動処理は変更しません。追加の常駐プロセスや起動スクリプトは不要です。標準OpenWrtのFlow Offloadingとは別の設定で、SQMや端末別QoSの追加には対応していません。

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

準備・起動用の2個と、RAMに展開するQSDK対応6個の、計8個の自作IPKを生成します。変更のない11個のIPKは公式リポジトリから取得し、GitHubには再配布しません。QSDK対応は `luci-mod-network`、iwinfoのライブラリとLua/RPCモジュール、`rpcd-mod-luci`、netifdプラグインに含みます。純正rpcd本体は使い続けます。RAM用パッケージはLuCIのバージョン情報も補い、更新後のJavaScriptをブラウザーが再取得できるようにします。

機種・認証・容量の検査は専用の `luci-qsdk-wn7t94xr-prepare` に含めています。iwinfoのIPKは標準のライブラリパッケージです。準備IPKは署名検証用の公開鍵とフィード設定も登録します。フィードを公開する際は `usign -S -m Packages -s <秘密鍵> -x Packages.sig` で署名してください。秘密鍵は配布物に含めません。

## RAMとoverlayの配置

`luci-base`、Network・Wireless・Software画面、Bootstrapテーマ、依存ライブラリ、uhttpd、QSDK連携の17個のIPKを、毎回の起動時にRAMへ取得します。各IPKのSHA-256とパッケージ名・バージョンを確認し、標準の `data.tar.gz` を展開します。別形式への再圧縮や、overlayへのダウンロード保存は行いません。

| 内容 | 保存先 |
| --- | --- |
| 起動処理、取得先とSHA-256の一覧、LuCI設定、フィード設定、設定したMAC許可・拒否リスト | overlay |
| 公式の11個のIPK | 公式アーカイブからRAMへ取得 |
| QSDK対応の6個のIPK | このフォークのGitHub ReleaseからRAMへ取得 |
| 展開したLuCI、ライブラリ、uhttpd、QSDK連携 | `/tmp/luci-ram` |
| 取得したIPKと展開途中のファイル | 展開後に削除 |
| 後からopkgで追加した拡張や変更 | `/overlay/luci-ram/upper` |

`luci-ram` はネットワーク起動後の `START=95` で全てを取得します。取得制限は各IPKにつき45秒です。全ての取得・検証・展開が終わるまで純正サービスやマウント構成は変更しません。取得に失敗した場合はLuCIを起動せず、純正のルーター機能とSSHは起動を続けます。オンライン復帰後は `/etc/init.d/luci-ram start` で再試行できます。同じ起動中に取得済みの場合は再ダウンロードしません。

停止時はマウントを解除してからネットワーク管理サービスを再起動します。netifdが無線ドライバーのディレクトリを開いたまま保持するため、その所有マウントに限り通常の解除に失敗した場合はlazy unmountを使います。参照はその後のnetifd再起動で閉じます。他のマウントの解除に失敗した場合は、ネットワークとRAMを保持して再試行できる状態を残します。

取得成功後はOverlayFSでLua、RPC、opkg管理情報、共有データ、Webファイル、netifdプラグインのディレクトリにRAM上のファイルを重ねます。ネットワーク起動処理、`/sbin/wifi`、iwinfoのライブラリはbind mountし、新規の実行ファイルとライブラリにはRAMを参照するシンボリックリンクを使います。純正領域のドライバー、ファームウェア、校正データは維持します。netifdはプロセス起動時にドライバープラグインを検出するため、RAMへの展開後にネットワーク管理サービスを一度再起動します。この際、通信が一時的に切れます。

17個の実行用パッケージの管理情報もRAMに生成するため、Software画面に表示され、opkgが依存関係を解決できます。後から追加した拡張の書き込み先はoverlayです。標準構成には追加拡張を保存せず、次回起動時に取得するファイルをRAMだけに配置します。`/etc/rc.local` にLuCIの起動処理を書く必要はありません。

## インストール

純正v2.5.1、rootシェル、インターネット接続が必要です。LuCIの事前インストールは不要です。有効なRPCdログイン設定を維持し、未設定の場合はOSのrootパスワードを使うログイン設定を作ります。rootパスワードが無効な場合は先に設定してください。認証情報や機器固有の校正データは配布物に含めません。

次の手順で永続領域に入るパッケージは、準備パッケージと起動パッケージの2個だけです。必要な実行用IPKは起動処理が取得します。最初のIPKをSHA-256で確認し、以後はopkgがフィードの署名とIPKのハッシュを検証します。

```sh
set -e
wn7_install_dir="$(mktemp -d /tmp/wn7-luci.XXXXXX)"
cd "$wn7_install_dir"
wn7_release=https://github.com/onokatio/luci/releases/download/v3.7.0-1
wn7_prepare=luci-qsdk-wn7t94xr-prepare_3.7.0-1_arm_cortex-a7_neon-vfpv4.ipk
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

[リリース](https://github.com/onokatio/luci/releases/tag/v3.7.0-1)のIPKには取得先とSHA-256を固定した一覧が入っています。公式IPKは[OpenWrtの公式アーカイブ](https://archive.openwrt.org/releases/packages-19.07/arm_cortex-a7_neon-vfpv4/)から取得します。準備パッケージは純正のネットワーク・無線制御の入口とログイン設定、起動パッケージ用の空き容量を検査します。未知の変更や容量不足では停止します。Dropbearの導入と設定は別途必要です。

v3.2.1以前の依存パッケージをoverlayへ入れた構成は、そのまま上書きできません。既存の設定とoverlayをPCへバックアップし、LuCI用の追加パッケージを削除し、置き換えたiwinfoの3パッケージをROM版へ戻してから移行してください。旧 `luci-base-ram` や `/overlay/luci-base` が残っている場合は、準備処理が停止します。純正の設定、SSH、無線の校正データは削除対象にしません。

この機器のopkgでは `--force-reinstall` を使わないでください。ROMにある他のパッケージのファイル一覧までoverlayへ複製し、容量を使い切る挙動を確認しました。更新時も通常の `install` を使います。

`opkg remove luci-qsdk-wn7t94xr` はLuCIを停止し、RAMのマウントを解除して純正のネットワーク起動処理を使う状態へ戻します。準備パッケージと設定、後から追加した拡張は自動では削除しません。
