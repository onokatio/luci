#!/bin/sh
set -eu
# SDK and sibling forks are explicit inputs, never device backup archives.
sdk="$(realpath "$1")"
iwinfo="$(realpath "$2")"
output="$(realpath -m "$3")"
rpcd="$(realpath "$4")"
git -C "$rpcd" diff --exit-code HEAD -- iwinfo.c
luci="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
stage="$sdk/staging_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi"
toolchain="$sdk/staging_dir/toolchain-arm_cortex-a7+neon-vfpv4_gcc-7.5.0_musl_eabi"
export STAGING_DIR="$stage"
cc="$toolchain/bin/arm-openwrt-linux-muslgnueabi-gcc"
strip="$toolchain/bin/arm-openwrt-linux-muslgnueabi-strip"
includes="-I$iwinfo/include -I$stage/usr/include -I$stage/usr/include/libnl-tiny"
mkdir -p "$output/usr/lib/lua" "$output/usr/lib/rpcd" "$output/usr/bin"
make -C "$iwinfo" CC="$cc" BACKENDS='nl80211 qcawificfg80211' SOVERSION=20230701 FPIC=-fPIC \
	CFLAGS="-Os -Wall -D_GNU_SOURCE -mfloat-abi=hard $includes" LDFLAGS="-L$iwinfo -L$stage/usr/lib -Wl,-rpath,/tmp/luci-ram/usr/lib -Wl,-z,relro,-z,now" compile
cp "$iwinfo/libiwinfo.so.20230701" "$output/usr/lib/"
cp "$iwinfo/iwinfo.so" "$output/usr/lib/lua/"
cp "$iwinfo/iwinfo" "$output/usr/bin/"
"$cc" -Os -Wall -Werror -std=gnu99 -fPIC -shared -mfloat-abi=hard $includes \
	"$luci/libs/rpcd-mod-luci/src/luci.c" -L"$stage/usr/lib" -lubox -lubus -luci -lnl-tiny -ldl \
	-Wl,-z,relro,-z,now -o "$output/usr/lib/rpcd/luci.so"
"$cc" -Os -Wall -Werror -std=gnu99 -fPIC -shared -mfloat-abi=hard $includes \
	"$rpcd/iwinfo.c" \
	-L"$iwinfo" -L"$stage/usr/lib" -liwinfo -lubox -lubus -luci -Wl,-rpath,/tmp/luci-ram/usr/lib -o "$output/usr/lib/rpcd/iwinfo.so"
"$strip" "$output/usr/lib/libiwinfo.so.20230701" "$output/usr/lib/lua/iwinfo.so" \
	"$output/usr/lib/rpcd/luci.so" "$output/usr/lib/rpcd/iwinfo.so" "$output/usr/bin/iwinfo"
# Compile complete sources with SDK types; execute the ARM tests with the same libraries.
checks="$output/selfchecks"
mkdir -p "$checks"
test_cflags="-Os -D_GNU_SOURCE -std=gnu99 -Wall -Werror -Wno-unused-function -mfloat-abi=hard -ffunction-sections -fdata-sections $includes"
test_ldflags="-L$stage/usr/lib -Wl,--gc-sections"
"$cc" $test_cflags "$iwinfo/tests/nl80211-selfcheck.c" $test_ldflags -lnl-tiny -o "$checks/nl80211"
"$cc" $test_cflags "$iwinfo/tests/qsdk-selfcheck.c" $test_ldflags -o "$checks/iwinfo"
"$cc" $test_cflags -I"$luci/libs/rpcd-mod-luci/src" \
	"$luci/contrib/wn7t94xr/hostapd-selfcheck.c" $test_ldflags -o "$checks/hostapd"
"$cc" $test_cflags "$luci/contrib/wn7t94xr/rate-selfcheck.c" $test_ldflags \
	-lubox -lblobmsg_json -ldl -Wl,--export-dynamic -o "$checks/rpc-rate"
for check in nl80211 iwinfo hostapd; do
	qemu-arm -L "$toolchain" -E "LD_LIBRARY_PATH=$stage/usr/lib" "$checks/$check"
done
qemu-arm -L "$toolchain" -E "LD_LIBRARY_PATH=$stage/usr/lib:$output/usr/lib" \
	"$checks/rpc-rate" "$output/usr/lib/rpcd/iwinfo.so" > "$checks/iwinfo.jsonl"
