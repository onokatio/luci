#!/bin/sh
set -eu
# SDK and sibling forks are explicit inputs, never device backup archives.
sdk="$(realpath "$1")"
iwinfo="$(realpath "$2")"
output="$(realpath -m "$3")"
luci="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
stage="$sdk/staging_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi"
toolchain="$sdk/staging_dir/toolchain-arm_cortex-a7+neon-vfpv4_gcc-7.5.0_musl_eabi"
export STAGING_DIR="$stage"
cc="$toolchain/bin/arm-openwrt-linux-muslgnueabi-gcc"
strip="$toolchain/bin/arm-openwrt-linux-muslgnueabi-strip"
includes="-I$iwinfo/include -I$stage/usr/include -I$stage/usr/include/libnl-tiny"
mkdir -p "$output/usr/lib/lua" "$output/usr/lib/rpcd" "$output/usr/bin"
make -C "$iwinfo" CC="$cc" BACKENDS='nl80211 qcawificfg80211' FPIC=-fPIC \
	CFLAGS="-Os -Wall -D_GNU_SOURCE -mfloat-abi=hard $includes" LDFLAGS="-L$stage/usr/lib -Wl,-z,relro,-z,now" compile
cp "$iwinfo/libiwinfo.so" "$output/usr/lib/"
cp "$iwinfo/iwinfo.so" "$output/usr/lib/lua/"
cp "$iwinfo/iwinfo" "$output/usr/bin/"
rpcd_source="$(find "$sdk/build_dir" -path '*/rpcd-*/iwinfo.c' -print | head -1)"
[ -n "$rpcd_source" ]
"$cc" -Os -Wall -Werror -std=gnu99 -fPIC -shared -mfloat-abi=hard $includes \
	-I"$iwinfo/include" -I"$(dirname "$rpcd_source")/include" \
	"$luci/libs/rpcd-mod-luci/src/luci.c" -L"$stage/usr/lib" -lubox -lubus -luci -lnl-tiny -ldl \
	-Wl,-z,relro,-z,now -o "$output/usr/lib/rpcd/luci.so"
"$cc" -Os -Wall -Werror -std=gnu99 -fPIC -shared -mfloat-abi=hard $includes \
	-I"$iwinfo/include" -I"$(dirname "$rpcd_source")/include" "$rpcd_source" \
	-L"$stage/usr/lib" -L"$iwinfo" -liwinfo -lubox -lubus -luci -o "$output/usr/lib/rpcd/iwinfo.so"
"$strip" "$output/usr/lib/libiwinfo.so" "$output/usr/lib/lua/iwinfo.so" \
	"$output/usr/lib/rpcd/luci.so" "$output/usr/lib/rpcd/iwinfo.so" "$output/usr/bin/iwinfo"
cc -D_GNU_SOURCE -std=gnu99 -Wall -Werror $includes -I"$iwinfo/include" \
	"$iwinfo/tests/qsdk-selfcheck.c" -o /tmp/qsdk-iwinfo-selfcheck
/tmp/qsdk-iwinfo-selfcheck
python3 - "$luci/libs/rpcd-mod-luci/src/luci.c" "$output/qsdk-switch.inc" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
readstr = source[source.index('static char *\nreadstr('):source.index('static char *\nea2str(')]
switch = source[source.index('/* QSDK switch topology */'):source.index('/* End QSDK switch topology */')]
pathlib.Path(sys.argv[2]).write_text(readstr + switch)
PY
host="$sdk/staging_dir/host"
cc -std=gnu99 -Wall -Werror -I"$host/include" -I"$output" \
	"$luci/contrib/wn7t94xr/switch-selfcheck.c" -L"$host/lib" -lblobmsg_json -lubox \
	-Wl,-rpath,"$host/lib" -o /tmp/qsdk-switch-selfcheck
/tmp/qsdk-switch-selfcheck
