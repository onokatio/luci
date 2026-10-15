#!/bin/sh
set -eu
sdk="$(realpath "$1")"
sources="$(realpath -m "$2")"
out="$(realpath -m "$3")"
here="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
luci="$(realpath "$here/../..")"
stage="$sdk/staging_dir/target-arm_cortex-a7+neon-vfpv4_musl_eabi"
tc="$sdk/staging_dir/toolchain-arm_cortex-a7+neon-vfpv4_gcc-7.5.0_musl_eabi/bin"
cc="$tc/arm-openwrt-linux-muslgnueabi-gcc"
strip="$tc/arm-openwrt-linux-muslgnueabi-strip"
export STAGING_DIR="$stage"
mkdir -p "$sources" "$out"
python3 - "$here/sources.json" "$sources" <<'PY'
import hashlib,json,pathlib,subprocess,sys
lock=json.load(open(sys.argv[1])); root=pathlib.Path(sys.argv[2])
for name, record in lock['runtime_sources'].items():
    if 'revision' in record:
        dest=root/name
        if not dest.exists():
            subprocess.run(['git','clone','--filter=blob:none','--no-checkout',record['url'],str(dest)],check=True)
        subprocess.run(['git','-C',str(dest),'checkout','--detach',record['revision']],check=True)
        assert subprocess.check_output(['git','-C',str(dest),'rev-parse','HEAD'],text=True).strip()==record['revision']
    else:
        dest=root/(name + ('.tar.gz' if name=='json-c' else '.c'))
        if not dest.exists():
            subprocess.run(['curl','-fsSL','--retry','2','--connect-timeout','20','--max-time','120',record['url'],'-o',str(dest)],check=True)
        assert hashlib.sha256(dest.read_bytes()).hexdigest()==record['sha256'],name
PY
build="$out/runtime-build"
prefix="$build/root"
mkdir -p "$build/json-c" "$prefix"
tar xzf "$sources/json-c.tar.gz" --strip-components=1 -C "$build/json-c"
cat > "$build/toolchain.cmake" <<CMAKE
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR arm)
set(CMAKE_C_COMPILER "$cc")
set(CMAKE_C_FLAGS_INIT "-Os -mfloat-abi=hard -I$prefix/usr/include")
set(CMAKE_FIND_ROOT_PATH "$prefix" "$stage")
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_INSTALL_RPATH /tmp/luci-ram/usr/lib)
CMAKE
cmake -S "$build/json-c" -B "$build/json-build" -DCMAKE_TOOLCHAIN_FILE="$build/toolchain.cmake" \
 -DCMAKE_INSTALL_PREFIX=/usr -DBUILD_STATIC_LIBS=ON -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF -DBUILD_APPS=OFF
cmake --build "$build/json-build" -j4
DESTDIR="$prefix" cmake --install "$build/json-build"
# musl 1.1 has no qsort_r. Supply the upstream implementation without replacing libc.
sed -e 's/#include "atomic.h"/#define a_ctz_l(x) ((x) ? __builtin_ctzl(x) : 0)/' \
 -e 's/void __qsort_r/void qsort_r/' -e '/weak_alias(__qsort_r, qsort_r);/d' "$sources/qsort.c" > "$build/qsort.c"
"$cc" -Os -fPIC -mfloat-abi=hard -include "$here/qsort-compat.h" -c "$build/qsort.c" -o "$build/qsort.o"
export PKG_CONFIG_SYSROOT_DIR="$prefix" PKG_CONFIG_LIBDIR="$prefix/usr/lib/pkgconfig"
# Hide JSON symbols inside libucode, so native rpcd keeps its original JSON ABI.
cmake -S "$sources/ucode" -B "$build/ucode-build" -DCMAKE_TOOLCHAIN_FILE="$build/toolchain.cmake" \
 -DCMAKE_C_FLAGS="-Os -mfloat-abi=hard -I$prefix/usr/include -include $here/qsort-compat.h" \
 -DCMAKE_SHARED_LINKER_FLAGS="$build/qsort.o -Wl,--exclude-libs,libjson-c.a" \
 -Dpkgcfg_lib_JSONC_json-c="$prefix/usr/lib/libjson-c.a" -DCMAKE_INSTALL_PREFIX=/usr -DCMAKE_INSTALL_LIBDIR=lib -DSOVERSION=20230711 \
 -DUBUS_SUPPORT=ON -DUCI_SUPPORT=ON -DFS_SUPPORT=ON -DMATH_SUPPORT=ON -DLOG_SUPPORT=ON \
 -DDEBUG_SUPPORT=OFF -DNL80211_SUPPORT=OFF -DRTNL_SUPPORT=OFF -DRESOLV_SUPPORT=OFF \
 -DSOCKET_SUPPORT=OFF -DZLIB_SUPPORT=OFF -DDIGEST_SUPPORT=OFF -DULOOP_SUPPORT=OFF -DIO_SUPPORT=OFF -DSTRUCT_SUPPORT=OFF
cmake --build "$build/ucode-build" -j4
DESTDIR="$prefix" cmake --install "$build/ucode-build"
cmake -S "$sources/lucihttp" -B "$build/http-build" -DCMAKE_TOOLCHAIN_FILE="$build/toolchain.cmake" \
 -DCMAKE_INSTALL_PREFIX=/usr -DBUILD_LUA=OFF -DBUILD_TESTS=OFF -DBUILD_UCODE=ON -DCMAKE_SHARED_LINKER_FLAGS="-L$prefix/usr/lib"
# Relink the binding when an incremental build changes the ucode ABI.
rm -f "$build/http-build/ucode/lucihttp.so"
cmake --build "$build/http-build" -j4
DESTDIR="$prefix" cmake --install "$build/http-build"
mkdir -p "$out/usr/lib/ucode/luci" "$out/usr/lib/rpcd" "$out/usr/bin"
"$cc" -Os -Wall -fPIC -shared -mfloat-abi=hard -I"$prefix/usr/include" -I"$stage/usr/include" \
 "$luci/contrib/package/ucode-mod-html/src/html.c" -o "$out/usr/lib/ucode/html.so"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$here/sources.json")"
rm -f "$luci/modules/luci-base/src/version.uc"
make -C "$luci/modules/luci-base/src" CC="$cc" CFLAGS="-Os -mfloat-abi=hard -I$prefix/usr/include" FPIC=-fPIC \
 LDFLAGS="-Wl,-rpath,/tmp/luci-ram/usr/lib -L$stage/usr/lib" LUCI_VERSION="25.12+qsdk$version" \
 LUCI_GITBRANCH='LuCI openwrt-25.12 branch' DESTDIR="$out" install
rpcd_header="$(find "$sdk/build_dir" -path '*/rpcd-*/include/rpcd/plugin.h' -print -quit)"
[ -n "$rpcd_header" ]
"$cc" -Os -Wall -Werror -fPIC -shared -mfloat-abi=hard -DINSTALL_PREFIX='"/usr"' -I"$prefix/usr/include" \
 -I"$stage/usr/include" -I"$(dirname "$(dirname "$rpcd_header")")" "$sources/rpcd/ucode.c" \
 -L"$prefix/usr/lib" -L"$stage/usr/lib" -Wl,-rpath,/tmp/luci-ram/usr/lib -lucode -lubus -lubox -o "$out/usr/lib/rpcd/ucode.so"
mkdir -p "$out/usr/share/licenses/libucode20230711"
cp "$sources/ucode/LICENSE" "$out/usr/share/licenses/libucode20230711/ucode.txt"
cp "$build/json-c/COPYING" "$out/usr/share/licenses/libucode20230711/json-c.txt"
sed '/^[[:space:]]*\*\//q' "$sources/qsort.c" > "$out/usr/share/licenses/libucode20230711/qsort.txt"
cp -a "$prefix/usr/bin/ucode" "$out/usr/bin/"
cp -a "$prefix/usr/lib/libucode.so.20230711" "$prefix/usr/lib/liblucihttp.so.0" "$prefix/usr/lib/liblucihttp.so.0.1" "$out/usr/lib/"
for module in fs log uci ubus math lucihttp; do cp "$prefix/usr/lib/ucode/$module.so" "$out/usr/lib/ucode/"; done
find "$out/usr" -type f \( -name '*.so' -o -name '*.so.[0-9]*' -o -name ucode \) -exec "$strip" '{}' +
[ -z "$("$tc/arm-openwrt-linux-muslgnueabi-nm" -D "$out/usr/lib/libucode.so.20230711" | awk '$2=="T" && $3 ~ /^json_/')" ]

"$tc/arm-openwrt-linux-muslgnueabi-readelf" -d "$out/usr/lib/ucode/lucihttp.so" | grep -q 'Shared library: \[libucode.so.20230711\]'
"$tc/arm-openwrt-linux-muslgnueabi-readelf" -d "$out/usr/bin/ucode" | grep -q 'Shared library: \[libucode.so.20230711\]'
