# WN-7T94XR QSDK 対応フォーク

純正ドライバーを使い、LuCI 25.12 の標準 Wireless 画面で AP を管理するためのフォークです。[実装・IPK・導入手順](contrib/wn7t94xr/README.md)を参照してください。

## コンポーネントと呼び出し関係

以下は、純正ファームウェア v2.5.1 上で LuCI 25.12 を動かす `qsdk-25.12` ブランチの構成です。矢印は要求・呼び出しの方向を示し、応答は原則として逆向きに戻ります。ソースに基づく構成図であり、実機の通信トレースではありません。

| 表記 | 意味 |
| --- | --- |
| 純正 | WN-7T94XR のオリジナルファームウェア（QSDK ベース）に元から入っているコンポーネント。 |
| 公式 | OpenWrt／LuCI の公式リポジトリにある実装。本体向けにビルドし直したものも含みます。 |
| フォーク | 公式実装に QSDK 互換対応などの変更を加えたもの。 |
| 独自 | RAM 展開や純正との連携など、この構成のために作った処理。 |

純正コンポーネントにも OpenWrt 由来のコードは含まれます。ここではコードの起源ではなく、本体に元からあるものを使うか、今回追加したものかで区別しています。

### Wireless の設定変更

```mermaid
flowchart TD
    UI["ブラウザー内の LuCI<br/>［フォーク］Wireless・network.js<br/>［公式］フォーム・保存・適用"]
    HTTP["［公式］追加 uhttpd :8080<br/>LuCI CGI／ucode<br/>HTTP → ubus の中継"]

    subgraph RPC["［純正］rpcd プロセス"]
        UCIAPI["純正 UCI RPC<br/>設定の保存・適用"]
    end

    CONFIG[("永続設定<br/>/etc/config/wireless<br/>/etc/config/network")]
    EVENT["［純正］procd など<br/>設定変更イベント"]
    WRAP["［独自］network 起動処理・/sbin/wifi<br/>無線操作を標準 ubus へ接続"]

    subgraph NET["［純正］netifd プロセス"]
        CORE["変更していない netifd 本体"]
    end

    PLUGIN["［フォーク：netifd リポジトリ］<br/>qcawificfg80211.sh<br/>標準形式の無線プラグイン"]
    OEM["［純正］/rom/sbin/wifi<br/>QSDK の無線制御・設定生成"]
    AUTH["［純正］hostapd／wpa_supplicant"]
    DRIVER["［純正］無線ドライバー・ファームウェア<br/>無線ハードウェア"]
    WEB["純正 Web 設定画面<br/>→ 純正 FcgiApp"]

    UI -->|"HTTP・JSON-RPC"| HTTP
    HTTP -->|"ubus：uci"| UCIAPI
    UCIAPI -->|"保存"| CONFIG
    UCIAPI -->|"適用通知"| EVENT
    EVENT --> WRAP
    WRAP -->|"ubus：network／network.wireless"| CORE
    CORE -->|"setup／teardown"| PLUGIN
    PLUGIN -->|"UCI を読む"| CONFIG
    PLUGIN -->|"純正処理を呼ぶ"| OEM
    OEM --> AUTH
    OEM --> DRIVER
    AUTH --> DRIVER
    PLUGIN -.->|"起動前に不足する標準設定を補完"| AUTH
    PLUGIN -->|"VAP・ブリッジの状態を通知"| CORE
    WEB -->|"同じ UCI 設定を保存"| CONFIG
```

LuCI 側で設定名・暗号形式を変換し、既存 MLO のリンク間で共有設定を同期します。その後は純正 netifd、追加した無線プラグイン、純正 QSDK 制御処理の順に反映します。netifd リポジトリのフォークから使うのは無線プラグインと `/sbin/wifi` の処理であり、netifd 本体のバイナリは交換しません。

純正 Web 設定画面も同じ UCI 設定を使います。純正画面からの反映経路は API ごとに異なるため、図では共通の保存先までを示しています。

### 無線状態・接続端末・Switch 情報の取得

```mermaid
flowchart TD
    UI["LuCI の標準画面<br/>Wireless・Associated Stations・Switch"]
    HTTP["［公式］uhttpd → LuCI CGI<br/>ubus の HTTP 中継"]

    subgraph RPC["［純正］rpcd プロセス内に追加して動く"]
        LRPC["［フォーク］rpcd-mod-luci<br/>無線状態・MLO リンクの補正<br/>board.json の取得"]
        IRPC["［フォーク］rpcd-mod-iwinfo<br/>公式 RPC ＋ 汎用の未取得項目処理"]
        URPC["［公式］rpcd-mod-ucode<br/>＋ QSDK 対応した LuCI スクリプト<br/>機能情報・Switch の状態を返す"]
        DISCONNECT["［独自］hostapd 互換 API<br/>hostapd.ath*.del_client"]
    end

    IW["［フォーク］新しい libiwinfo<br/>QSDK 固有の取得・帯域補正<br/>＋ 公式 nl80211／WEXT 処理"]
    NET["［純正］netifd<br/>network.wireless の状態"]
    NATIVE["［純正］wlanconfig・sysfs<br/>nl80211・WEXT／ドライバー"]
    HOST["［純正］hostapd"]
    BOARD[("RAM 上の board.json<br/>［独自］不足するポート定義を補完")]
    SW["［純正］swconfig<br/>Switch の状態・VLAN"]
    BIN["［純正］hostapd／wpa_supplicant<br/>既知バイナリの機能情報"]

    UI --> HTTP
    HTTP -->|"ubus"| LRPC
    HTTP -->|"ubus"| IRPC
    HTTP -->|"ubus"| URPC
    HTTP -->|"ubus：端末切断"| DISCONNECT
    LRPC -->|"ubus"| NET
    LRPC -->|"同一プロセス内のライブラリ呼び出し"| IW
    IRPC -->|"同一プロセス内のライブラリ呼び出し"| IW
    IW --> NATIVE
    LRPC --> BOARD
    URPC --> SW
    URPC --> BIN
    DISCONNECT -->|"UNIX 制御ソケット"| HOST
```

`rpcd-mod-*` は純正 rpcd が読み込む拡張です。端末切断用の互換 API は `rpcd-mod-luci` に含まれ、同じプロセス内で動きます。別の常駐デーモンは追加しません。図の `ubus` は純正の ubus バスを経由する呼び出しを表します。

新しい `libiwinfo.so.20230701` は LuCI の RPC 拡張が使います。純正プログラムが使う旧 libiwinfo は残し、両者を分けています。既知の純正 hostapd／wpa_supplicant はハッシュで判定し、対応する機能情報を返します。未知のバイナリには公式の機能検査を使います。

QSDK 固有の取得と周波数帯の補正は libiwinfo が担当します。`rpcd-mod-iwinfo` はバックエンド名で分岐せず、libiwinfo が返す取得済み項目のマスクに従い、不明な統計・状態を応答から省きます。マスクを提供しない従来のバックエンドでは、公式と同じ出力を保ちます。不明な MCS・GI の省略と、標準画面が使う `no_ir` の出力も汎用処理として残しており、RPC は公式の無改変版ではありません。

### 起動時の RAM 展開

```mermaid
flowchart TD
    BOOT["本体起動"]
    OEM["［純正］ネットワーク・無線が起動"]
    SSH["［公式・追加済み］Dropbear SSH<br/>LuCI に依存せず起動"]
    START["［独自・overlay に常駐］luci-ram"]
    DOWNLOAD["公式アーカイブ／フォークの Release<br/>固定した IPK を取得・検証"]
    RAM["RAM：/tmp/luci-ram<br/>LuCI・ucode・RPC 拡張・ライブラリ<br/>無線プラグイン・SQM など"]
    MOUNT["［独自］OverlayFS・bind mount<br/>必要なファイルを実行環境へ接続"]
    RPC["純正 rpcd を再起動<br/>追加 RPC 拡張を読み込む"]
    NET["純正 netifd を再起動<br/>無線プラグインを検出"]
    WEB["追加 uhttpd・LuCI が起動"]
    UPPER[("永続 overlay<br/>設定・後から追加した拡張・変更")]
    FAILURE["LuCI は起動しない<br/>純正ルーター機能・SSH を維持<br/>必要なら SQM 用に止めた加速を復旧"]

    BOOT --> OEM
    BOOT --> SSH
    OEM --> START
    START --> DOWNLOAD
    DOWNLOAD -->|"全て成功"| RAM
    DOWNLOAD -.->|"失敗"| FAILURE
    RAM --> MOUNT
    UPPER -->|"書き込み・変更を保持"| MOUNT
    MOUNT --> RPC
    RPC --> NET
    NET --> WEB
```

RAM 展開後も、実際に動く rpcd・netifd 本体は純正バイナリです。追加部分を認識させるために再起動する段階で、通信が一時的に切れます。ダウンロードが完了するまでは純正サービスとマウント構成を変更しません。

### SQM と純正アクセラレーションの連携

```mermaid
flowchart TD
    UI["［公式］LuCI SQM 画面"]
    CFG[("永続 UCI 設定：sqm")]
    SERVICE["［独自］SQM 起動・停止の連携処理"]
    SQM["［公式］sqm-scripts・tc"]
    KERNEL["［純正］カーネルの CAKE・IFB"]
    ACCEL["［純正］qca-nss-ecm<br/>PPE／SFE アクセラレーション"]

    UI -->|"標準 UCI RPC 経由で保存・適用"| CFG
    CFG -.->|"設定変更に伴うサービス再読み込み"| SERVICE
    SERVICE -->|"開始・停止"| SQM
    SQM -->|"キューを設定"| KERNEL
    SERVICE -->|"SQM 使用中は停止<br/>終了・失敗時に元の状態へ復旧"| ACCEL
```

通常の通信パケットは LuCI や rpcd を通りません。これらの図は管理・設定用の経路を示しています。実際の転送は純正ドライバー、カーネル、アクセラレーション側が担当します。

### 図の更新

コンポーネントの追加・削除・置き換え、呼び出し先・通信方式、RAM／overlay の配置、起動・停止・失敗時の動作を変更した場合は、同じ変更で該当する図と説明も更新してください。LuCI・iwinfo・netifd のどのフォークを変更した場合も、この README を確認します。図はここで管理し、他の文書からはリンクして参照します。

# OpenWrt luci feed

[![Translation status](https://hosted.weblate.org/widgets/openwrt/-/svg-badge.svg)](https://hosted.weblate.org/engage/openwrt/?utm_source=widget)

## Description

This is the OpenWrt "luci"-feed containing LuCI - OpenWrt Configuration Interface.

## Usage

This feed is enabled by default. Your feeds.conf.default (or feeds.conf) should contain a line like:
```
src-git luci https://github.com/openwrt/luci.git
```

To install all its package definitions, run:
```sh
./scripts/feeds update luci
./scripts/feeds install -a -p luci
```

## API Reference

You can browse the generated API documentation directly on Github.

Use [ucode](https://ucode.mein.io/) and rpcd for server side operations.

 - [Client side JavaScript APIs](http://openwrt.github.io/luci/jsapi/index.html)

## Development

Documentation for developing and extending LuCI can be found [in the Wiki](https://github.com/openwrt/luci/wiki)

## License

See [LICENSE](LICENSE) file.
 
## Package Guidelines

See [CONTRIBUTING.md](CONTRIBUTING.md) file.

## Translation status

Use [Weblate](https://hosted.weblate.org/engage/openwrt/?utm_source=widget) instead of direct editing of the `*.po` files.

[![Translation status](https://hosted.weblate.org/widgets/openwrt/-/multi-auto.svg)](https://hosted.weblate.org/engage/openwrt/?utm_source=widget)
