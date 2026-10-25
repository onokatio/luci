#!/usr/bin/env python3
"""Build a minimal bootstrap and separate, downloaded RAM runtime IPKs."""
import gzip
import hashlib
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile
import zlib
from concurrent.futures import ThreadPoolExecutor

HERE = pathlib.Path(__file__).resolve().parent
LUCI = HERE.parents[1]
SDK, NATIVE, NETIFD, CACHE, OUT = map(pathlib.Path, sys.argv[1:])
os.umask(0o022)
os.environ['SOURCE_DATE_EPOCH'] = '0'
os.environ['PATH'] = str(SDK.resolve() / 'staging_dir/host/bin') + os.pathsep + os.environ['PATH']
ARCH = 'arm_cortex-a7_neon-vfpv4'
VERSION = json.loads((HERE / 'sources.json').read_text())['version']
PREPARE = 'luci-qsdk-wn7t94xr-prepare'
PREPARE_PATH = 'usr/libexec/luci-qsdk-prepare'
PREPARE_KIB = 16
FEED_KEY = 'ac707de45b8bb751'
FEED_URL = 'https://github.com/onokatio/luci/releases/download/v' + VERSION
LOCK = json.loads((HERE / 'sources.json').read_text())
OUT.mkdir(parents=True, exist_ok=True)
assert not list(OUT.glob('*.ipk')), 'Use an output directory without old IPKs'


def read_archive(data):
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for item in tar:
            name = item.name.removeprefix('./')
            if item.isdir():
                continue
            path = pathlib.PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts
            assert item.isfile() or item.issym(), name
            entries[name] = (item.linkname if item.issym() else tar.extractfile(item).read(), item.mode)
    return entries


packages, versions, sizes = set(), {}, {}


def write_package(name, version, payload, hooks):
    path = OUT / f'{name}_{version}_{ARCH}.ipk'
    hooks['control'] = (hooks['control'][0] + b'Installed-Size: 0\n', 0o644)
    with tempfile.TemporaryDirectory() as directory:
        root = pathlib.Path(directory)
        root.chmod(0o755)
        for filename, (data, mode) in (payload | {'CONTROL/' + key: value for key, value in hooks.items()}).items():
            relative = pathlib.PurePosixPath(filename)
            assert not relative.is_absolute() and '..' not in relative.parts
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(data, str):
                target.symlink_to(data)
            else:
                target.write_bytes(data)
                target.chmod(mode)
        subprocess.run([str(SDK.resolve() / 'scripts/ipkg-build'), '-o', '0', '-g', '0', str(root), str(OUT.resolve())],
                       check=True)
        record(path, payload, (root / 'CONTROL/control').read_text())


def flash_bytes(payload):
    # Include inode/index overhead: the first live install exceeded the data-only estimate.
    return sum(sum(min(len(data[i:i+4096]), len(zlib.compress(data[i:i+4096]))) + 48
                    for i in range(0, len(data), 4096)) + 1024
                for data, _ in payload.values() if isinstance(data, bytes))


def record(path, payload, control):
    fields = dict(re.findall(r'^([A-Za-z-]+): (.*)$', control, re.M))
    if path.parent == OUT:
        packages.add(fields['Package'])
    versions[fields['Package']] = fields['Version']
    logical = sum(len(data) for data, _ in payload.values() if isinstance(data, bytes))
    sizes[fields['Package']] = {'name': fields['Package'], 'ipk_bytes': path.stat().st_size,
                              'file_bytes': logical, 'file_count': len(payload), 'estimated_ubifs_bytes': flash_bytes(payload)}


def control(name, depends, version=VERSION, provides=''):
    text = f"Package: {name}\nVersion: {version}\nArchitecture: {ARCH}\nDepends: {depends}\nSection: luci\nMaintainer: onokatio\nLicense: Apache-2.0 AND ISC AND MIT\nDescription: LuCI 25.12 userspace for WN-7T94XR stock v2.5.1\n"
    return text + ('Provides: ' + provides + '\n' if provides else '') + ('Replaces: sqm-scripts\n' if name == 'luci-qsdk-wn7t94xr-runtime' else '')


def emit(name, depends, payload, provides='', version=VERSION):
    write_package(name, version, payload, {'control': (control(name, depends, version=version, provides=provides).encode(), 0o644)})


def download(package):
    url = package.get('url') or ('https://archive.openwrt.org/releases/packages-19.07/'
           + ARCH + '/' + package['feed'] + '/' + package['filename'])
    mirror, filename = url.rsplit('/', 1)
    subprocess.run([str(SDK.resolve() / 'scripts/download.pl'), str(CACHE.resolve()), package['filename'],
                    package['sha256'], filename, mirror], check=True,
                   env=os.environ | {'TOPDIR': str(SDK.resolve()), 'CURL_OPTIONS': '--no-insecure --max-time 120'})


CACHE.mkdir(parents=True, exist_ok=True)
available = {p['name'] for p in LOCK['base_packages']} | set(LOCK['rom_packages']) | {
    'libc', 'libpthread', 'opkg', 'libiwinfo20181126', 'libiwinfo-lua',
    'rpcd-mod-iwinfo', 'rpcd-mod-luci', 'kmod-sched-cake'}
for package in LOCK['base_packages']:
    assert all(d.split(' ')[0] in available for d in package['depends'].split(', ') if d)
with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(download, LOCK['base_packages']))


# Keep compatible native utilities as separate hash-pinned official 19.07 IPKs.
for package in LOCK['base_packages']:
    original = CACHE / package['filename']
    assert hashlib.sha256(original.read_bytes()).hexdigest() == package['sha256'], package['name']
    ipk = read_archive(original.read_bytes())
    record(original, read_archive(ipk['data.tar.gz'][0]), read_archive(ipk['control.tar.gz'][0])['control'][0].decode())

native = {
    'uhttpd': (['usr/sbin/uhttpd', 'usr/lib/uhttpd/libustream-ssl.so'], 'libc, libubox20191228, libblobmsg-json, libjson-script, libjson-c2, libmbedtls12'),
    'uhttpd-mod-ubus': (['usr/lib/uhttpd_ubus.so'], 'libc, uhttpd, libubus20210603, libblobmsg-json'),
    'uhttpd-mod-ucode': (['usr/lib/uhttpd_ucode.so'], 'libc, uhttpd, libucode20230711, libubox20191228'),
    'libiwinfo20230701': (['usr/lib/libiwinfo.so.20230701'], 'libc, libgcc, libuci20130104, libubus20210603, libubox20191228, libnl-tiny'),
    'rpcd-mod-iwinfo': (['usr/lib/rpcd/iwinfo.so'], 'libc, rpcd, libiwinfo20230701, libubox20191228, libubus20210603, libuci20130104'),
    'rpcd-mod-luci': (['usr/lib/rpcd/luci.so'], 'libc, rpcd, libiwinfo20230701, libubox20191228, libubus20210603, libuci20130104, libnl-tiny'),
    'libucode20230711': (['usr/lib/libucode.so.20230711'], 'libc, libgcc'),
    'ucode': (['usr/bin/ucode'], 'libc, libucode20230711'),
    'liblucihttp0': (['usr/lib/liblucihttp.so.0', 'usr/lib/liblucihttp.so.0.1'], 'libc'),
    'liblucihttp-ucode': (['usr/lib/ucode/lucihttp.so'], 'libc, libucode20230711, liblucihttp0'),
    'rpcd-mod-ucode': (['usr/lib/rpcd/ucode.so'], 'libc, rpcd, libucode20230711, libubus20210603, libubox20191228'),
}
for module in ['fs', 'log', 'uci', 'ubus', 'math', 'html']:
    native['ucode-mod-' + module] = (['usr/lib/ucode/' + module + '.so'], 'libc, libucode20230711' +
        (', libuci20130104' if module == 'uci' else ', libubus20210603, libubox20191228' if module == 'ubus' else ''))
# Keep compatibility fixes newer than the archived packages on the active feeds.
component_versions = {
    'uhttpd': '2026-10-19-ca796d7d-1',
    'uhttpd-mod-ubus': '2026-10-19-ca796d7d-1',
    'uhttpd-mod-ucode': '2026-10-19-ca796d7d-1',
    'libiwinfo20230701': '2026-05-26-66bdd1a0-1',
    'rpcd-mod-iwinfo': '2026-10-04-d99f703e-1',
    'rpcd-mod-luci': '20210614-1',
    'liblucihttp0': '2023.03.15-9b5b683f-1',
    'liblucihttp-ucode': '2023.03.15-9b5b683f-1',
}
component_versions = {name: version + '+qsdk' + VERSION for name, version in component_versions.items()}
for name, (filenames, depends) in native.items():
    payload = {}
    for filename in filenames:
        file = NATIVE / filename
        binary = file.readlink().as_posix() if file.is_symlink() else file.read_bytes()
        if isinstance(binary, bytes):
            assert binary[:6] == b'\x7fELF\x01\x01' and binary[18:20] == b'\x28\x00', filename
        payload[filename] = (binary, 0o755)
    if name == 'uhttpd':
        payload['etc/init.d/uhttpd'] = ((NATIVE / 'etc/init.d/uhttpd').read_bytes(), 0o755)
    if name.startswith('uhttpd-mod-'):
        depends = depends.replace('uhttpd,', 'uhttpd (= ' + component_versions['uhttpd'] + '),')
    if name == 'libucode20230711':
        payload.update({file.relative_to(NATIVE).as_posix(): (file.read_bytes(), 0o644)
                        for file in (NATIVE / 'usr/share/licenses/libucode20230711').iterdir()})
        assert len(payload) == 4
    if name in ('rpcd-mod-iwinfo', 'rpcd-mod-luci'):
        depends = depends.replace('libiwinfo20230701', 'libiwinfo20230701 (= ' + component_versions['libiwinfo20230701'] + ')')
    emit(name, depends, payload, 'libiwinfo' if name == 'libiwinfo20230701' else 'libucode' if name == 'libucode20230711' else '', version=component_versions.get(name, VERSION))

# Use the upstream recipes unchanged, including their dependency and architecture metadata.
make = ['make', 'TOPDIR=' + str(SDK.resolve()), 'PACKAGE_DIR=' + str(OUT.resolve()),
        'PKG_SRC_VERSION=25.12+qsdk' + VERSION, 'PKG_PO_VERSION=' + VERSION,
        'PKG_GITBRANCH=LuCI openwrt-25.12 branch', 'CONFIG_LUCI_JSMIN=y', 'CONFIG_LUCI_CSSTIDY=']
subprocess.run(make + ['host-compile'], cwd=LUCI / 'modules/luci-base', check=True)
for source in ['modules/luci-base', 'modules/luci-mod-network', 'libs/luci-lib-uqr',
               'themes/luci-theme-bootstrap', 'applications/luci-app-package-manager', 'applications/luci-app-sqm']:
    name = pathlib.Path(source).name
    include = str((NATIVE / 'runtime-build/root/usr/include').resolve())
    for target in ['clean', 'compile']:
        subprocess.run(make + ['CONFIG_PACKAGE_' + name + '=m', 'TARGET_CPPFLAGS=-I' + include,
                               target], cwd=LUCI / source, check=True)
    built, = OUT.glob(name + '_*.ipk')
    ipk = read_archive(built.read_bytes())
    record(built, read_archive(ipk['data.tar.gz'][0]), read_archive(ipk['control.tar.gz'][0])['control'][0].decode())

network = (HERE / 'root/etc/init.d/network').read_bytes()
wifi = (NETIFD / 'contrib/qsdk/wifi').read_bytes()
driver = (NETIFD / 'examples/wireless/qcawificfg80211.sh').read_bytes()
runtime_payload = {'etc/init.d/network': (network, 0o755), 'sbin/wifi': (wifi, 0o755),
                   'lib/netifd/wireless/qcawificfg80211.sh': (driver, 0o755),
                   'usr/lib/rpcd/qsdk-hostapd.so': ((NATIVE / 'usr/lib/rpcd/qsdk-hostapd.so').read_bytes(), 0o755),
                   'etc/hotplug.d/iface/11-sqm': ((HERE / 'root/etc/hotplug.d/iface/11-sqm').read_bytes(), 0o755)}
emit('luci-qsdk-wn7t94xr-runtime', 'libc, netifd, ubus, jshn, rpcd, libubus20210603, libubox20191228', runtime_payload, 'kmod-sched-cake')

manifest = []
for name, version in versions.items():
    path = next(p for p in OUT.glob('*.ipk') if p.name.startswith(name + '_')) if name in packages else next(
        CACHE / p['filename'] for p in LOCK['base_packages'] if p['name'] == name)
    url = FEED_URL + '/' + path.name if name in packages else next(
        'https://archive.openwrt.org/releases/packages-19.07/' + ARCH + '/' + p['feed'] + '/' + p['filename']
        for p in LOCK['base_packages'] if p['name'] == name)
    manifest.append(f'{name} {version} {hashlib.sha256(path.read_bytes()).hexdigest()} {url}\n')
manifest = ''.join(manifest).encode()

payload = {name: ((LUCI / 'modules/luci-base/root' / name).read_bytes(), 0o644) for name in ('etc/config/luci',)}
payload['etc/config/uhttpd'] = ((NATIVE / 'etc/config/uhttpd').read_bytes(), 0o644)
payload['etc/init.d/luci-ram'] = ((HERE / 'root/etc/init.d/luci-ram').read_bytes(), 0o755)
payload['etc/luci-qsdk/ram-packages'] = (manifest, 0o644)
payload['etc/init.d/uhttpd'] = ('/tmp/luci-ram/etc/init.d/uhttpd', 0o755)
payload['etc/init.d/ucitrack'] = ('/tmp/luci-ram/etc/init.d/ucitrack', 0o755)
payload['etc/init.d/sqm'] = ((HERE / 'root/etc/init.d/sqm').read_bytes(), 0o755)
payload['etc/hotplug.d/iface/11-sqm'] = ('/tmp/luci-ram/etc/hotplug.d/iface/11-sqm', 0o755)
payload['etc/config/sqm'] = (b"config queue 'uplink'\n\toption enabled '0'\n\toption interface 'eth0'\n\toption download '85000'\n\toption upload '10000'\n\toption qdisc 'cake'\n\toption script 'piece_of_cake.qos'\n\toption linklayer 'none'\n", 0o644)
for name in ('usr/lib/libiwinfo.so.20230701', 'usr/sbin/uhttpd', 'usr/bin/ucode', 'usr/libexec/cgi-io', 'usr/lib/liblucihttp.so.0', 'usr/lib/uhttpd_ubus.so', 'usr/lib/uhttpd_ucode.so'):
    payload[name] = ('/tmp/luci-ram/' + name, 0o755)

md5 = lambda data: hashlib.md5(data).hexdigest()
guard = f'''[ -z "$IPKG_INSTROOT" ] && [ "${{PKG_ROOT:-/}}" = / ] || {{ echo 'Install in the live root destination.' >&2; exit 1; }}
[ "$(md5sum /rom/etc/init.d/network | cut -d ' ' -f 1)" = f74e8e77542742781de3e29992bcdb02 ] || {{ echo 'Unsupported vendor network service.' >&2; exit 1; }}
[ "$(md5sum /rom/sbin/wifi | cut -d ' ' -f 1)" = 0f9e16e177b75c05e31d6300e96faa8e ] || {{ echo 'Unsupported native Wireless controller.' >&2; exit 1; }}
[ "$(md5sum /etc/init.d/rpcd | cut -d ' ' -f 1)" = 1f88f46a68f93a38f5d0ebdd1c71e89a ] || {{ echo 'Keep the native RPC service.' >&2; exit 1; }}
case "$(md5sum /etc/init.d/network | cut -d ' ' -f 1)" in f74e8e77542742781de3e29992bcdb02|{md5(network)}) ;; *) echo 'Unknown network entry point.' >&2; exit 1;; esac
case "$(md5sum /sbin/wifi | cut -d ' ' -f 1)" in 0f9e16e177b75c05e31d6300e96faa8e|{md5(wifi)}) ;; *) echo 'Unknown Wireless entry point.' >&2; exit 1;; esac
[ ! -e /lib/wifi/cust/wireless_backup ] && [ ! -e /tmp/.qca-wireless-reloading ] || {{ echo 'Finish the pending vendor Wireless change first.' >&2; exit 1; }}
'''
auth = r'''usable_login() {
 local section user password account hash read write
 for section in $(uci -q show rpcd | sed -n 's/^rpcd\.\([^=]*\)=login$/\1/p'); do
  user="$(uci -q get "rpcd.$section.username")"
  password="$(uci -q get "rpcd.$section.password")"
  read=" $(uci -q get "rpcd.$section.read") "
  write=" $(uci -q get "rpcd.$section.write") "
  [ -n "$user" ] && [ "$read" = ' * ' ] && [ "$write" = ' * ' ] || continue
  case "$password" in
   '$p$'*) account="${password#\$p\$}"; hash="$(awk -F: -v user="$account" '$1==user {print $2}' /etc/shadow)";;
   *) hash="$password";;
  esac
  case "$hash" in ''|'!'*|'*'*) continue;; esac
  return 0
 done
 return 1
}
'''
required_kib = (flash_bytes(payload) + PREPARE_KIB * 1024 + 16384 + 1023) // 1024 + 32
prepare = '#!/bin/sh\nset -e\n' + guard + auth + f'''if ! usable_login; then
 hash="$(awk -F: '$1=="root" {{print $2}}' /etc/shadow)"
 case "$hash" in ''|'!'*|'*'*) echo 'Set a root password before installing LuCI.' >&2; exit 1;; esac
 [ -z "$(uci -q get rpcd.qsdk_luci)" ] || exit 1
fi
if [ -e /etc/init.d/luci-base-ram ] || [ -d /overlay/luci-base ]; then
 echo 'Remove the previous persistent LuCI installation before migrating to the all-RAM bootstrap.' >&2
 exit 1
fi
sync
available="$(df -k /overlay | awk 'NR==2 {{print $4}}')"
[ "$available" -ge {required_kib} ] || {{ echo 'Insufficient space for the bootstrap and reserve.' >&2; exit 1; }}
'''
prepare_control = f'''Package: {PREPARE}
Version: {VERSION}
Architecture: {ARCH}
Depends: libc, opkg, uci, usign
Section: luci
Priority: optional
Maintainer: onokatio
License: GPL-2.0-only
Description: Device checks and signed feed for the WN-7T94XR RAM LuCI bootstrap
'''
prepare_payload = {PREPARE_PATH: (prepare.encode(), 0o755),
                   'etc/opkg/wn7t94xr-luci.conf': (f'src/gz wn7t94xr_luci {FEED_URL}\n'.encode(), 0o644),
                   'etc/opkg/keys/' + FEED_KEY: ((HERE / 'feed.pub').read_bytes(), 0o644)}
prepare_hooks = {'control': (prepare_control.encode(), 0o644), 'preinst': (prepare.encode(), 0o755)}
prepare_hooks['postinst'] = (f'''#!/bin/sh
[ -z "$IPKG_INSTROOT" ] || exit 0
if [ "$(md5sum /etc/opkg/distfeeds.conf | cut -d ' ' -f 1)" = 42630a2cf0641aebf947488d21f57284 ]; then
 : > /etc/opkg/distfeeds.conf
 for feed in base luci packages routing; do
  echo "src/gz openwrt_$feed https://archive.openwrt.org/releases/packages-19.07/{ARCH}/$feed" >> /etc/opkg/distfeeds.conf
 done
fi
sed -i '\\|^src/gz openwrt_luci https://archive.openwrt.org/releases/packages-19.07/{ARCH}/luci$|d' /etc/opkg/distfeeds.conf
'''.encode(), 0o755)
assert flash_bytes(prepare_payload) + flash_bytes(prepare_hooks) <= PREPARE_KIB * 1024
write_package(PREPARE, VERSION, prepare_payload, prepare_hooks)
preinst = f'''#!/bin/sh
set -e
[ -x /{PREPARE_PATH} ] && [ "$(sed -n 's/^Version: //p' /usr/lib/opkg/info/{PREPARE}.control)" = {VERSION} ] || {{ echo 'Install {PREPARE} {VERSION} first.' >&2; exit 1; }}
exec /{PREPARE_PATH}
'''
postinst = '#!/bin/sh\nset -e\n[ -z "$IPKG_INSTROOT" ] || exit 0\n' + auth + '''if ! usable_login; then
 uci set rpcd.qsdk_luci=login
 uci set rpcd.qsdk_luci.username=root
 uci set rpcd.qsdk_luci.password='$p$root'
 uci add_list rpcd.qsdk_luci.read='*'
 uci add_list rpcd.qsdk_luci.write='*'
 uci commit rpcd
fi
# Older LuCI versions removed enabled flags required by the vendor Web API.
for section in $(uci -q show wireless | awk -F '[.=]' '$3 == "wifi-device" || $3 == "wifi-iface" { print $2 }'); do
 radio="$section"
 [ "$(uci -q get "wireless.$section")" != wifi-iface ] || radio="$(uci -q get "wireless.$section.device")"
 [ "$(uci -q get "wireless.$radio.type")" = qcawificfg80211 ] || continue
 uci -q get "wireless.$section.disabled" >/dev/null || uci set "wireless.$section.disabled=0"
done
uci commit wireless
uci -q delete uhttpd.main.listen_http || true
uci -q delete uhttpd.main.listen_https || true
uci -q delete uhttpd.main.lua_prefix || true
uci -q delete uhttpd.main.ucode_prefix || true
uci add_list uhttpd.main.ucode_prefix='/cgi-bin/luci=/usr/share/ucode/luci/uhttpd.uc'
uci add_list uhttpd.main.listen_http=0.0.0.0:8080
uci set uhttpd.main.ubus_prefix=/ubus
uci set uhttpd.main.redirect_https=0
uci commit uhttpd
uci set luci.main.ubuspath=/cgi-bin/luci/admin/ubus
uci commit luci
/etc/init.d/luci-ram disable
/etc/init.d/luci-ram enable
/etc/init.d/sqm enable
sync
echo 'Installed the all-RAM LuCI bootstrap. Reboot or run /etc/init.d/luci-ram start.'
'''
prerm = '''#!/bin/sh
[ "$PKG_UPGRADE" = 1 ] && exit 0
[ -z "$IPKG_INSTROOT" ] || exit 0
/etc/init.d/luci-ram stop || exit 1
/etc/init.d/luci-ram disable
'''
control = f'''Package: luci-qsdk-wn7t94xr
Version: {VERSION}
Architecture: {ARCH}
Depends: libc, curl, opkg, uci, netifd, ubus, jshn, {PREPARE} (= {VERSION})
Section: luci
Priority: optional
Maintainer: onokatio
License: GPL-2.0-only
Description: Boot-time downloads of the complete QSDK LuCI runtime into RAM
 Keeps only the bootstrap and configuration on flash. Retains vendor drivers.
'''
hooks = {'control': (control.encode(), 0o644),
         'conffiles': (b'/etc/config/luci\n/etc/config/uhttpd\n/etc/config/sqm\n', 0o644)}
hooks.update({name: (data.encode(), 0o755) for name, data in [
    ('preinst', preinst), ('postinst', postinst), ('prerm', prerm)]})
write_package('luci-qsdk-wn7t94xr', VERSION, payload, hooks)
with (OUT / 'Packages').open('w') as index:
    subprocess.run([str(SDK.resolve() / 'scripts/ipkg-make-index.sh'), '.'], cwd=OUT, stdout=index, check=True)
(OUT / 'Packages.gz').write_bytes(gzip.compress((OUT / 'Packages').read_bytes(), mtime=0))
(OUT / 'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in sorted(OUT.glob('*.ipk'))))
(OUT / 'sizes.json').write_text(json.dumps({'preflight_kib': required_kib,
    'boot_download_bytes': sum(s['ipk_bytes'] for name, s in sizes.items() if name not in (PREPARE, 'luci-qsdk-wn7t94xr')),
    'packages': list(sizes.values())}, indent=2) + '\n')
for size in sizes.values():
    print(f"{size['name']}: IPK {size['ipk_bytes']} bytes, files {size['file_bytes']} bytes")
print(f'Custom feed: {len(packages)} IPKs; RAM runtime: {len(manifest.splitlines())} IPKs; bootstrap flash budget {required_kib} KiB')
