# WN-7T94XR の QSDK Wireless・Switch 対応

I-O DATA WN-7T94XR の純正ファームウェア v2.5.1 で、LuCI 25.12 の標準 Wireless・Switch 画面を使うための実装です。ドライバー、ファームウェア、校正データは本体のものを使います。

実装は次のフォークで管理しています。

| フォーク | 変更内容 |
| --- | --- |
| [netifd / qsdk-legacy](https://github.com/onokatio/netifd/tree/qsdk-legacy) | 標準の wireless driver プラグイン。純正の制御処理を呼び、無線インターフェースの状態とブリッジへの接続を netifd に通知します。 |
| [iwinfo / qsdk-25.12](https://github.com/onokatio/iwinfo/tree/qsdk-25.12) | 新しい公式iwinfoを基に、QSDKのラジオ名とVAPの対応、純正hostapdの情報取得、WEXTスキャンを追加しています。HE/EHT・6 GHz・320 MHzの処理は公式実装を使います。 |
| [LuCI / qsdk-25.12](https://github.com/onokatio/luci/tree/qsdk-25.12) | `rpcd-mod-luci` の MLO・純正APIとの連携、QSDK の UCI 形式に合わせた標準 Wireless フォーム、IPK のビルド処理を含みます。 |

状態の取得には `network.wireless`、`luci-rpc.getWirelessDevices`、`iwinfo` を使います。不足する情報の取得には既存の `rpcd-mod-luci` を拡張しています。常駐デーモンは追加しません。`/lib/netifd/wireless/qcawificfg80211.sh` は netifd が読み込む標準形式のドライバープラグインです。

MLOを含む設定変更は、純正の制御処理でラジオ全体に適用します。同じ設定には、netifdから複数のsetup呼び出しが来ても適用を一度にまとめる処理があります。片方のラジオを停止した場合は、残る有効なラジオの再起動と共有MLDのブリッジ接続の復元も必要です。このため、単一ラジオの操作でもMLOグループの通信が一時的に切れることがあります。MLOのブリッジには `mld*` を接続し、LuCIには各リンクの `ath*` の情報を返します。

追加APのインターフェース名は、純正管理画面とEasyMeshが使う番号を避けて割り当てます。追加直後は無効にし、SSID・暗号化・パスワードを設定してから有効にできます。有効なラジオではスキャンと、スキャン結果からのClient接続を使えます。通常のClientはブリッジに接続せず、独立したDHCPインターフェースに割り当てます。BSSID入力欄はClientだけに表示し、接続先の固定に使います。

## 25.12への移行

LuCI本体は公式の `openwrt-25.12` ブランチを使います。周波数の選択、HE/EHTの速度表示、802.11k/v、SQM、パッケージ管理の画面は公式実装を使い、QSDKの設定名や値を変換する処理を加えています。既存の純正MLOの設定と動作を維持し、グループ作成やリンク割り当ての独自UIは提供しません。

25.12のucode実行環境を、純正v2.5.1のユーザー空間ABI向けにビルドします。ucodeが必要とする新しいJSONライブラリはlibucodeへ静的に組み込み、シンボルを非公開にします。純正rpcdやWeb設定画面は元のJSONライブラリを使い続けます。古いmuslにない `qsort_r()` には、musl 1.2.5の実装を組み込みます。カーネル、純正ドライバー、rpcd本体は置き換えません。

### 公式実装への置き換え

v5.1.0-1では、iwinfoを公式の `66bdd1a0`、rpcd-mod-iwinfoを公式の `d99f703e` を基に更新しました。rpcd本体は純正のままです。新しいiwinfoには別のSONAME（`libiwinfo.so.20230701`）を付け、純正プログラムが使う旧ライブラリを維持します。LuCIのRPC拡張だけが新しいライブラリを使います。

純正hostapd・wpa_supplicantの既知のバイナリに限り、OpenWrt形式の機能情報を返します。Wireless画面のACS・11ac/ax/be・暗号化方式・WPSは、この情報を使う公式の選択処理へ統一しました。未知のバイナリでは、公式の機能検査へ戻ります。EAPの鍵とWPSの設定名には標準フォームの `ucioption` を使い、MLOで共有する値の書き込み処理は維持しています。

v5.5.0-2では、共通設定の読み書き・削除に公式フォームの処理を使い、その結果を既存MLOのリンクへ同期します。QSDKの設定名には `ucioption` を使い、EAP・鍵ホルダー一覧の値を変換します。PMFの無効値はQSDKで必要なため明示的に保存します。保存・取消・追加APの取消は公式のモーダル処理に任せ、失敗時の通知だけを補います。ラジオのモードと帯域幅はiwinfoで正規化し、画面の選択肢は公式処理で組み立てます。11r・EAP・WPSも公式の機能情報で判定します。暗号形式、Clientのブリッジ制約、既存MLOの同期とRAM展開方式は維持します。

v5.6.0-1では、保存失敗の通知を公開APIの `addModalOptions()` と `Map.save()` へ接続し、保存・取消の内部メソッドへの依存を外しました。設定項目の列挙には `getOption()` を使います。非対応の項目は生成時に除外し、表示条件は `depends()` へ渡す前にQSDK向けに調整します。フォーム内部の `children` や `deps` は書き換えません。JavaScriptの検査は、公式ローダーでモジュール全体を読み込み、実際に生成したフォーム項目の公開APIを通して行います。DOM描画と外部I/Oはテスト用に置き換え、保存・取消・QR画面の操作は実機ブラウザーで確認します。

Switchのポート構成は、DTSで機種と配線を確認してからRAM上の `board.json` に補います。既存の項目やポート情報は上書きしません。標準の `getBoardJSON` がこの情報を返すため、RPC内の専用JSON生成処理は不要になりました。LuCI停止時は元の `board.json` が見える状態へ戻します。

LuCIの起動とSQMにはLuaを使いません。追加するLuCI拡張も25.12用を使ってください。19.07用のLuCI拡張は混在できません。25.12公式配布のAPKを、この本体のopkgで直接インストールすることもできません。拡張はこのSDK向けにIPK化する必要があります。

Interfaces画面は、純正netifdの `ifname` とインターフェース内のブリッジ設定を維持します。新形式への設定移行は行わず、デバイスの選択・ブリッジ・STP・IGMP snoopingを同じ画面で編集できます。新形式の独立したブリッジデバイスの作成は表示しません。

Webサーバーのubus公開先は `/ubus` にします。末尾にスラッシュがあると、クエリ付き要求が404になり、同じ接続の次の要求も400になるためです。LuCIは公式のCGI版ubus処理 `/cgi-bin/luci/admin/ubus` を使います。この本体では旧uhttpdの直接ubus処理がタイムアウトするため、標準の代替経路を設定します。

## Wirelessの対応範囲

| 標準画面の機能 | QSDKへの反映 |
| --- | --- |
| AP追加・削除、スキャン、Client接続 | 純正制御処理とnetifdの標準インターフェースを使います。 |
| AP/ClientのWDS、Monitor | 純正ドライバーのモードとWDS設定を使います。既存MLOのSSID・暗号化・モード・ネットワークの編集はグループ内で同期します。 |
| Legacy/N/AC/AX/BE、チャンネル、幅、国、送信出力 | ラジオの対応モードを取得し、QSDKのUCI形式へ保存します。送信出力の単位はdBmです。 |
| MAC許可・拒否リスト | 純正hostapdの標準ACLで判定します。追加APで正しく動かないドライバー側のACLは、競合を避けるため解除します。許可・拒否リストは設定ファイルとしてoverlayに保存し、ダウンロード失敗時にも純正hostapdが読める形式でUCIへ登録します。 |
| WMM、DTIM、ビーコン、RTS、プリアンブル、GTK更新、端末の無通信時間 | 純正の設定生成を使い、不足する標準項目はhostapdの起動前に補います。フラグメント閾値はLegacyモードで使えます。 |
| Distance Optimization | ラジオの距離を0〜21150mで指定し、純正APIでACKタイムアウトを調整します。空欄・0で元の値に戻します。 |
| WPA2/SAE、OWE、EAP/RADIUS、PMF、802.11r、WPSの有効化 | 純正hostapd/wpa_supplicantの設定へ反映します。6 GHzとMLOではSAE、OWE、WPA3-EAPの強い暗号化を選びます。 |
| 802.11k/v | 標準のNeighbor Report・Beacon Report・BSS Transitionの有効化を純正hostapdへ反映します。 |
| Associated Stations、Disconnect | iwinfoと標準の `hostapd.<ifname>.del_client` APIを使います。一時拒否は期限後に解除します。 |

純正ドライバーが公開しないAd-Hoc、802.11sは表示しません。802.11rの実際のローミング、RADIUSサーバーとの認証、WDSのブリッジ通信には、対応する別のAPや認証サーバーが必要です。設定の反映・サービスの起動確認と、これらの相互接続確認は区別します。

Distance Optimizationは、[iwの距離変換](https://git.kernel.org/pub/scm/linux/kernel/git/jberg/iw.git/tree/phy.c)と同じ450m単位で切り上げ、設定前のACKタイムアウトに1単位あたり3µsを加えます。WN-7T94XR v2.5.1の初期値は112µs、純正APIの許容範囲は112〜255µsです。CTS・スロット時間の純正値は維持し、動的推定の `auto` は受け付けません。距離の設定はoverlay、元のACK値はRAMへ保存し、設定解除とラジオ停止で元の値に戻します。純正の設定生成に距離の反映処理がないため、netifdのドライバープラグインが起動後に反映します。RAM側の起動に失敗した場合は、この調整を適用しません。距離の上限はタイムアウトの設定範囲を示す値で、電波が届く距離を保証するものではありません。

Associated Stationsでは、純正 `wlanconfig` の端末一覧と、端末を指定したnl80211のGET_STATIONを合わせて取得します。一覧の取得が空でも、端末別のバイト数・パケット数・接続時間・認証状態を返せます。HE/EHT・帯域幅・NSSは純正の端末情報から取得します。接続モードの情報で、パケットごとの変動は表しません。送受信速度は、nl80211が不自然な値を返すため、純正一覧のMbps単位の値を使います。最新パケットのMCSやGIを取得できない場合は推測して表示しません。独立した取得スクリプトやデーモンは追加しません。

## Switch構成情報

純正の `/etc/board.json` にポート定義がないため、標準Switch画面は `has an unknown topology` と表示します。起動処理がRAM上の `board.json` に欠けている `switch1.ports` を補い、標準API `luci-rpc.getBoardJSON` が読み取ります。既存のポート定義や、モデル・ネットワーク設定・他のSwitch情報は保持します。純正のファイルは書き換えず、LuCI停止時にRAMのマウントを解除します。

実行中のDTSがAP-MI01.6とQCA8386を示し、デバイス番号・CPU/LAN/WANのビットマップ・Ethernet1のエイリアスとdp2の接続属性が一致した場合だけ補完します。QSDKのeth1はsysfsではvirtualデバイスとして公開されるため、DTS側の対応情報を参照します。CPU側はポート0のeth1、外部ポートは1〜3です。10GbpsのWAN側eth0は、この外部Switchのポートには含めません。

筐体のLAN1・LAN2・LAN3が、それぞれSSDKのポート1・2・3に対応することを、実機のケーブル差し替えとリンク状態で確認しました。画面にもLAN1〜LAN3を表示します。リンク状態とVLAN機能の取得には、既存の標準RPCと純正 `swconfig` を使います。この追加処理はVLANの有効化や設定変更を行いません。VLANを編集する際は、CPUポートとLANインターフェースの対応を確認してください。VLAN機能を無効にする場合は、設定項目を削除せず `enable_vlan=0` を保存します。QSDKでは項目がないと有効な状態が残るため、標準フォームの保存処理を修正しました。

## フラグメント閾値と接続端末一覧

フラグメント閾値はLegacyモードのAPごとに反映し、同じラジオ内の別APへ上書きしません。256〜2346バイトの偶数を指定でき、空欄へ戻すと解除します。純正ドライバーはN・AC・AX・BEモードで従来のフラグメント閾値を反映しないため、そのモードでは入力値を保存できません。HEのフラグメント能力とは別の設定です。

Associated Stationsは公式の接続端末一覧とDisconnectを使います。端末DetailsとMCS・GIの使用分布、専用のTelemetry取得処理は削除しました。速度や帯域幅などの標準表示は維持し、ドライバーが報告しないMCS・GIを速度から推定しません。

QSDKランタイムのバージョンごとにJavaScriptのキャッシュキーを更新するため、更新後は通常の再読み込みで新しい画面を取得できます。

EAP ClientはPEAP・TTLSの内部認証をwpa_supplicantの設定へ変換します。TTLSのEAP方式には `autheap=`、PEAPには `auth=` を使います。純正wpa_supplicantにFASTは組み込まれていないため、WN-7T94XRでは選択肢から外しています。


## SQM・帯域制御

Network → SQM QoSは公式 `luci-app-sqm` と `sqm-scripts` を使います。CAKE・IFBは純正カーネルの既存モジュールを使います。SQMが有効な間はECMのPPE/SFE加速を止め、全キューを無効にしたときやLuCIを停止したときに、開始前の加速設定へ戻します。加速を元から無効にしていた場合は無効を保ちます。

設定とSQMの起動・復旧処理はoverlay、SQM本体と依存パッケージは起動時にRAMへ取得します。取得に失敗した場合は、SQMのために止めていた加速を元に戻します。初期状態ではSQMを無効にしています。対象インターフェースと回線速度を設定して有効にしてください。ソフトウェア処理になるため、最大速度はCPU性能に制限されます。AP／ブリッジ構成では、実際の通信経路が指定したキューを通ることを確認してください。

## IPK のビルド

Linux amd64 と OpenWrt 19.07.10 の ipq40xx SDK を使います。SDK はユーザー空間のモジュールをビルドするために使い、カーネルやファームウェアは置き換えません。

SDK のファイル名は `openwrt-sdk-19.07.10-ipq40xx-generic_gcc-7.5.0_musl_eabi.Linux-x86_64.tar.xz`、SHA-256 は `b7c5e68c3d327a91dc5761f2d56c20a41e6846f36727f2c675810466d83b7306` です。[公式アーカイブ](https://archive.openwrt.org/releases/19.07.10/targets/ipq40xx/generic/)から取得してください。

`sources.json` の `forks` に記載したコミットを使います。SDK の base フィードも同ファイルの `sdk_base` に固定し、`libubox ubus uci lua libnl-tiny rpcd` を登録してビルドします。ソースを保持するため `CONFIG_AUTOREMOVE` を無効にしてください。SDK は Python 2 を要求します。

```sh
node contrib/wn7t94xr/selfcheck.js
python3 ../netifd/contrib/qsdk/selfcheck.py
python3 ../iwinfo/tests/channel-selfcheck.py
sh contrib/wn7t94xr/build-native.sh /path/to/sdk ../iwinfo /tmp/wn7-native
sh contrib/wn7t94xr/build-runtime.sh /path/to/sdk /tmp/wn7-runtime-sources /tmp/wn7-native
python3 contrib/wn7t94xr/build-ipk.py /path/to/sdk /tmp/wn7-native ../netifd /tmp/wn7-base-cache ./dist/wn7t94xr
python3 contrib/wn7t94xr/ipk-selfcheck.py ./dist/wn7t94xr /tmp/wn7-base-cache
```

`luci-base`、`luci-mod-network`、`luci-lib-uqr`、`luci-theme-bootstrap`、`luci-app-package-manager`、`luci-app-sqm` は、各パッケージの公式Makefileと `luci.mk` を変更せず、SDKのパッケージビルドで生成します。ファイルの配置、依存関係、アーキテクチャ、JavaScriptの圧縮、バージョン埋め込み、LuCI本体のコンパイルは公式の処理に任せます。生成したIPKは作り直さず、そのままフィードへ登録します。

依存IPKは `build-ipk.py` からSDKの `scripts/download.pl` で取得し、SHA-256とTLS証明書を検証します。rpcdのヘッダーは、SDKが `Build/InstallDev` で配置したものを使います。SDK内部のビルドディレクトリは探索しません。

QSDKのABIに合わせるライブラリ・RPC拡張と、機種検査・RAM起動用のパッケージは従来のビルド処理を使います。公式Makefileへの移行により、互換処理が増える部分は移していません。LuCIのIPKに含まれる設定ファイルもRAMへ展開し、起動時にパッケージのインストールスクリプトは実行しません。overlay上の設定とサービスの準備は、引き続き起動パッケージが担当します。

準備・起動用の2個と、RAM用の21個の、計23個のIPKを生成します。互換性のある4個のIPK（cgi-io、uhttpd、uhttpd-mod-ubus、sqm-scripts）は公式リポジトリから取得します。25.12の画面と、純正ABI向けにビルドする実行環境は、このフォークのIPKとして配布します。ソースと依存IPKの取得先、コミット、SHA-256は `sources.json` に固定しています。ビルド手順は `.github/workflows/qsdk.yml` にもあります。

機種・認証・容量の検査は専用の `luci-qsdk-wn7t94xr-prepare` に含めています。iwinfoのIPKは標準のライブラリパッケージです。準備IPKは署名検証用の公開鍵とフィード設定も登録します。フィードを公開する際は `usign -S -m Packages -s <秘密鍵> -x Packages.sig` で署名してください。秘密鍵は配布物に含めません。

## RAMとoverlayの配置

`luci-base`、Network・Wireless・Software画面、Bootstrapテーマ、依存ライブラリ、uhttpd、QSDK連携の25個のIPKを、毎回の起動時にRAMへ取得します。各IPKのSHA-256とパッケージ名・バージョンを確認し、標準の `data.tar.gz` を展開します。別形式への再圧縮や、overlayへのダウンロード保存は行いません。

| 内容 | 保存先 |
| --- | --- |
| 起動処理、取得先とSHA-256の一覧、LuCI設定、フィード設定、設定したMAC許可・拒否リスト | overlay |
| 公式の4個のIPK | 公式アーカイブからRAMへ取得 |
| LuCI 25.12とQSDK対応の21個のIPK | このフォークのGitHub ReleaseからRAMへ取得 |
| 展開したLuCI、ライブラリ、uhttpd、QSDK連携 | `/tmp/luci-ram` |
| 取得したIPKと展開途中のファイル | 展開後に削除 |
| 後からopkgで追加した拡張や変更 | `/overlay/luci-ram/upper` |

`luci-ram` はネットワーク起動後の `START=99` で全てを取得します。接続待ちは10秒、取得制限は各IPKにつき45秒です。失敗時は3秒間隔で最大4回再試行します。全ての取得・検証・展開が終わるまで純正サービスやマウント構成は変更しません。取得に失敗した場合はLuCIを起動せず、純正のルーター機能とSSHは起動を続けます。オンライン復帰後は `/etc/init.d/luci-ram start` で再試行できます。同じ起動中に取得済みの場合は再ダウンロードしません。

停止時はマウントを解除してからネットワーク管理サービスを再起動します。netifdが無線ドライバーのディレクトリを開いたまま保持するため、その所有マウントに限り通常の解除に失敗した場合はlazy unmountを使います。参照はその後のnetifd再起動で閉じます。他のマウントの解除に失敗した場合は、ネットワークとRAMを保持して再試行できる状態を残します。

取得成功後はOverlayFSでucode、RPC、実行補助スクリプト、opkg管理情報、共有データ、Webファイル、netifdプラグインのディレクトリにRAM上のファイルを重ねます。ネットワーク起動処理、`/sbin/wifi`、`board.json`はbind mountし、新規の実行ファイルとライブラリにはRAMを参照するシンボリックリンクを使います。純正領域のドライバー、ファームウェア、校正データは維持します。netifdはプロセス起動時にドライバープラグインを検出するため、RAMへの展開後にネットワーク管理サービスを一度再起動します。この際、通信が一時的に切れます。

25個の実行用パッケージの管理情報もRAMに生成するため、Software画面に表示され、opkgが依存関係を解決できます。後から追加した拡張の書き込み先はoverlayです。標準構成には追加拡張を保存せず、次回起動時に取得するファイルをRAMだけに配置します。`/etc/rc.local` にLuCIの起動処理を書く必要はありません。

## 旧バージョンからの更新

v3.11.0-3から更新する場合は、設定をバックアップし、`/etc/init.d/luci-ram stop` で旧LuCIを停止してから下の手順を実行してください。これにより、更新する起動パッケージを永続領域へインストールできます。停止時にネットワーク管理サービスが再起動するため、接続が切れた場合はSSHへ接続し直してください。既存の無線設定、LuCIのログイン設定、Dropbearの設定は維持します。

後から19.07用のLuCI拡張を入れている場合は、更新前にその拡張を外し、25.12用のIPKへ移行してください。純正ABI向けの通常パッケージは19.07系のフィードを使い続けますが、旧LuCI用の公式フィードは登録解除します。

## インストール

純正v2.5.1、rootシェル、インターネット接続が必要です。LuCIの事前インストールは不要です。有効なRPCdログイン設定を維持し、未設定の場合はOSのrootパスワードを使うログイン設定を作ります。rootパスワードが無効な場合は先に設定してください。認証情報や機器固有の校正データは配布物に含めません。

次の手順で永続領域に入るパッケージは、準備パッケージと起動パッケージの2個だけです。必要な実行用IPKは起動処理が取得します。最初のIPKをSHA-256で確認し、以後はopkgがフィードの署名とIPKのハッシュを検証します。

```sh
set -e
wn7_install_dir="$(mktemp -d /tmp/wn7-luci.XXXXXX)"
cd "$wn7_install_dir"
wn7_release=https://github.com/onokatio/luci/releases/download/v5.6.0-1
wn7_prepare=luci-qsdk-wn7t94xr-prepare_5.6.0-1_arm_cortex-a7_neon-vfpv4.ipk
curl -fL "$wn7_release/$wn7_prepare" -o "$wn7_prepare"
curl -fL "$wn7_release/SHA256SUMS" -o SHA256SUMS
awk -v name="$wn7_prepare" '$2 == name' SHA256SUMS > prepare.sha256
test "$(wc -l < prepare.sha256)" -eq 1
sha256sum -c prepare.sha256
opkg --force-space install "./$wn7_prepare"
opkg update
# 更新時は旧起動処理でRAMのマウントを解除してから入れ替えます。
[ ! -x /etc/init.d/luci-ram ] || /etc/init.d/luci-ram stop
opkg --force-space install luci-qsdk-wn7t94xr
/etc/init.d/luci-ram start
```

[リリース](https://github.com/onokatio/luci/releases/tag/v5.6.0-1)のIPKには取得先とSHA-256を固定した一覧が入っています。公式IPKは[OpenWrtの公式アーカイブ](https://archive.openwrt.org/releases/packages-19.07/arm_cortex-a7_neon-vfpv4/)から取得します。準備パッケージは純正のネットワーク・無線制御の入口とログイン設定、起動パッケージ用の空き容量を検査します。未知の変更や容量不足では停止します。Dropbearの導入と設定は別途必要です。

v3.2.1以前の依存パッケージをoverlayへ入れた構成は、そのまま上書きできません。既存の設定とoverlayをPCへバックアップし、LuCI用の追加パッケージを削除し、置き換えたiwinfoの3パッケージをROM版へ戻してから移行してください。旧 `luci-base-ram` や `/overlay/luci-base` が残っている場合は、準備処理が停止します。純正の設定、SSH、無線の校正データは削除対象にしません。

この機器のopkgでは `--force-reinstall` を使わないでください。ROMにある他のパッケージのファイル一覧までoverlayへ複製し、容量を使い切る挙動を確認しました。更新時も通常の `install` を使います。

`opkg remove luci-qsdk-wn7t94xr` はLuCIを停止し、RAMのマウントを解除して純正のネットワーク起動処理を使う状態へ戻します。準備パッケージと設定、後から追加した拡張は自動では削除しません。
