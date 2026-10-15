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
	-I"$iwinfo/include" -I"$(dirname "$rpcd_source")/include" "$luci/libs/rpcd-mod-iwinfo/src/iwinfo.c" \
	-L"$stage/usr/lib" -L"$iwinfo" -liwinfo -lubox -lubus -luci -o "$output/usr/lib/rpcd/iwinfo.so"
"$strip" "$output/usr/lib/libiwinfo.so" "$output/usr/lib/lua/iwinfo.so" \
	"$output/usr/lib/rpcd/luci.so" "$output/usr/lib/rpcd/iwinfo.so" "$output/usr/bin/iwinfo"
python3 - "$iwinfo" "$output" <<'RATE'
import pathlib, sys
source = (pathlib.Path(sys.argv[1]) / 'iwinfo_nl80211.c').read_text()
start = source.index('static void nl80211_parse_rateinfo(')
end = source.index('static int nl80211_get_survey_cb(', start)
(pathlib.Path(sys.argv[2]) / 'qsdk-nl-rate.inc').write_text(source[start:end])
RATE
cc -D_GNU_SOURCE -std=gnu99 -Wall -Werror $includes -I"$output" -I"$iwinfo/include" \
	"$iwinfo/tests/qsdk-selfcheck.c" -o /tmp/qsdk-iwinfo-selfcheck
/tmp/qsdk-iwinfo-selfcheck
python3 - "$luci/libs/rpcd-mod-luci/src/luci.c" "$output/qsdk-switch.inc" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
start = source.index('static char *\nreadstr(')
readstr = source[start:source.index('\n}\n', start) + 3]
switch = source[source.index('/* QSDK switch topology */'):source.index('/* End QSDK switch topology */')]
pathlib.Path(sys.argv[2]).write_text(readstr + switch)
PY
host="$sdk/staging_dir/host"
cc -std=gnu99 -Wall -Werror -I"$host/include" -I"$output" \
	"$luci/contrib/wn7t94xr/switch-selfcheck.c" "$host/lib/libblobmsg_json.a" \
	"$host/lib/libubox.a" "$host/lib/libjson-c.a" -lm -o /tmp/qsdk-switch-selfcheck
/tmp/qsdk-switch-selfcheck
python3 - "$luci" "$output" <<'PY'
import pathlib, sys
luci, output = map(pathlib.Path, sys.argv[1:])
control = (luci / 'libs/rpcd-mod-luci/src/qsdk-hostapd.h').read_text()
(output / 'qsdk-hostapd-control.inc').write_text(control[:control.index('struct qsdk_hostapd_ban')])
rpc = (luci / 'libs/rpcd-mod-iwinfo/src/iwinfo.c').read_text()
(output / 'qsdk-rate.inc').write_text(rpc[rpc.index('static void\nrpc_iwinfo_add_rateinfo('):rpc.index('static int\nrpc_iwinfo_assoclist(')])
PY
cc -D_GNU_SOURCE -std=gnu99 -Wall -Werror -I"$output" -I"$luci/libs/rpcd-mod-luci/src" \
	"$luci/contrib/wn7t94xr/hostapd-selfcheck.c" -o /tmp/qsdk-hostapd-selfcheck
/tmp/qsdk-hostapd-selfcheck
cc -D_GNU_SOURCE -std=gnu99 -Wall -Werror -Wno-unused-function -I"$luci/libs/rpcd-mod-luci/src" -I"$host/include" \
 "$luci/contrib/wn7t94xr/management-selfcheck.c" "$host/lib/libblobmsg_json.a" \
 "$host/lib/libubox.a" "$host/lib/libjson-c.a" -lm -o /tmp/qsdk-management-selfcheck
/tmp/qsdk-management-selfcheck
cc -D_GNU_SOURCE -std=gnu99 -Wall -Werror -I"$luci/libs/rpcd-mod-luci/src" -I"$luci/libs/rpcd-mod-iwinfo/src" -I"$host/include" -I"$output" -I"$iwinfo/include" -I"$stage/usr/include" \
	"$luci/contrib/wn7t94xr/rate-selfcheck.c" "$host/lib/libblobmsg_json.a" \
	"$host/lib/libubox.a" "$host/lib/libjson-c.a" -lm -o /tmp/qsdk-rate-selfcheck
/tmp/qsdk-rate-selfcheck
cc -std=gnu99 -Wall -Werror -I"$luci/libs/rpcd-mod-luci/src" -I"$host/include" \
	"$luci/contrib/wn7t94xr/acceleration-selfcheck.c" "$host/lib/libblobmsg_json.a" \
	"$host/lib/libubox.a" "$host/lib/libjson-c.a" -lm -o /tmp/qsdk-acceleration-selfcheck
/tmp/qsdk-acceleration-selfcheck
cc -D_GNU_SOURCE -std=gnu99 -Wall -Werror -I"$luci/libs/rpcd-mod-luci/src" -I"$luci/libs/rpcd-mod-iwinfo/src" \
	"$luci/contrib/wn7t94xr/telemetry-selfcheck.c" -o /tmp/qsdk-telemetry-selfcheck
/tmp/qsdk-telemetry-selfcheck
"$cc" -D_GNU_SOURCE -Os -std=gnu99 -Wall -Werror -mfloat-abi=hard \
	-I"$luci/libs/rpcd-mod-luci/src" -I"$luci/libs/rpcd-mod-iwinfo/src" \
	"$luci/contrib/wn7t94xr/telemetry-selfcheck.c" -o "$output/telemetry-selfcheck"

python3 - "$luci/libs/rpcd-mod-luci/src/qsdk-switch-controls.h" "$output/qsdk-switch-controls.inc" <<'CHECK'
import pathlib,sys
source=pathlib.Path(sys.argv[1]).read_text()
parts=[source[source.index('struct qsdk_switch_port'):source.index('static bool qsdk_ssdk_batch')],source[source.index('static bool qsdk_ssdk_field'):source.index('static bool qsdk_switch_read')],source[source.index('static bool qsdk_switch_valid'):source.index('static bool qsdk_switch_write')],source[source.index('static unsigned int qsdk_switch_rate'):source.index('static const char *const qsdk_switch_keys')]]
pathlib.Path(sys.argv[2]).write_text('\n'.join(parts))
CHECK
cc -std=gnu99 -Wall -Werror -I"$output" "$luci/contrib/wn7t94xr/switch-controls-selfcheck.c" -o /tmp/qsdk-switch-controls-selfcheck
/tmp/qsdk-switch-controls-selfcheck
