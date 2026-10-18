# WN-7T94XR QSDK 対応フォーク

純正ドライバーを使い、LuCI の標準 Wireless 画面で AP を管理するためのフォークです。現行の LuCI 25.12 対応は [`qsdk-25.12`](https://github.com/onokatio/luci/tree/qsdk-25.12) で管理しています。

現行構成の[コンポーネントと呼び出し関係の図](https://github.com/onokatio/luci/blob/qsdk-25.12/README.md#コンポーネントと呼び出し関係)と、[実装・IPK・導入手順](https://github.com/onokatio/luci/blob/qsdk-25.12/contrib/wn7t94xr/README.md)を参照してください。図は現行ブランチの README で管理し、構成変更時に更新します。

このブランチ `qsdk-19.07` は LuCI 19.07 対応の旧系統です。[旧版の説明](contrib/wn7t94xr/README.md)も残しています。

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
```
./scripts/feeds update luci
./scripts/feeds install -a -p luci
```

## API Reference

You can browse the generated API documentation [directly on Github](http://htmlpreview.github.io/?http://raw.githubusercontent.com/openwrt/luci/master/documentation/api/index.html).

## Development

Documentation for developing and extending LuCI can be found [in the Wiki](https://github.com/openwrt/luci/wiki)

## License

See [LICENSE](LICENSE) file.
 
## Package Guidelines

See [CONTRIBUTING.md](CONTRIBUTING.md) file.

## Translation status

[![Translation status](https://hosted.weblate.org/widgets/openwrt/-/multi-auto.svg)](https://hosted.weblate.org/engage/openwrt/?utm_source=widget)
