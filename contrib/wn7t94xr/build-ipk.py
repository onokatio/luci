#!/usr/bin/env python3
"""Build a minimal bootstrap and separate, downloaded RAM runtime IPKs."""
import gzip
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import zlib

HERE = pathlib.Path(__file__).resolve().parent
LUCI = HERE.parents[1]
NATIVE, NETIFD, CACHE, OUT = map(pathlib.Path, sys.argv[1:])
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
jsmin = OUT / 'jsmin'
subprocess.run(['cc', '-O2', str(LUCI / 'modules/luci-base/src/jsmin.c'), '-o', str(jsmin)], check=True)


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        directories = {str(parent) for name in entries for parent in pathlib.PurePosixPath(name).parents if str(parent) != '.'}
        for directory in sorted(directories):
            item = tarfile.TarInfo(directory + '/')
            item.type, item.mode = tarfile.DIRTYPE, 0o755
            tar.addfile(item)
        for name, (payload, mode) in sorted(entries.items()):
            path = pathlib.PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts
            item = tarfile.TarInfo(name)
            item.mode = mode
            if isinstance(payload, str):
                item.type, item.linkname = tarfile.SYMTYPE, payload
                tar.addfile(item)
            else:
                item.size = len(payload)
                tar.addfile(item, io.BytesIO(payload))
    return gzip.compress(stream.getvalue(), compresslevel=9, mtime=0)


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


packages, versions, sizes = {}, {}, {}


def write_package(name, version, payload, hooks):
    installed = sum(len(data) for data, _ in payload.values() if isinstance(data, bytes))
    control = hooks['control'][0].decode()
    control = re.sub(r'^Installed-Size: .*\n', '', control, flags=re.M) + f'Installed-Size: {installed}\n'
    hooks['control'] = (control.encode(), 0o644)
    path = OUT / f'{name}_{version}_{ARCH}.ipk'
    path.write_bytes(archive({'debian-binary': (b'2.0\n', 0o644), 'control.tar.gz': (archive(hooks), 0o644), 'data.tar.gz': (archive(payload), 0o644)}))
    record(path, payload, control)


def flash_bytes(payload):
    # Include inode/index overhead: the first live install exceeded the data-only estimate.
    return sum(sum(min(len(data[i:i+4096]), len(zlib.compress(data[i:i+4096]))) + 48
                    for i in range(0, len(data), 4096)) + 1024
                for data, _ in payload.values() if isinstance(data, bytes))


def record(path, payload, control):
    fields = dict(re.findall(r'^([A-Za-z-]+): (.*)$', control, re.M))
    if path.parent == OUT:
        packages[fields['Package']] = control.rstrip() + f'\nFilename: {path.name}\nSize: {path.stat().st_size}\nSHA256sum: {hashlib.sha256(path.read_bytes()).hexdigest()}\n\n'
    versions[fields['Package']] = fields['Version']
    logical = sum(len(data) for data, _ in payload.values() if isinstance(data, bytes))
    sizes[fields['Package']] = {'name': fields['Package'], 'ipk_bytes': path.stat().st_size,
                              'file_bytes': logical, 'file_count': len(payload), 'estimated_ubifs_bytes': flash_bytes(payload)}


def control(name, depends, version=VERSION, provides=''):
    text = f"Package: {name}\nVersion: {version}\nArchitecture: {ARCH}\nDepends: {depends}\nSection: luci\nMaintainer: onokatio\nLicense: Apache-2.0 AND ISC AND MIT\nDescription: LuCI 25.12 userspace for WN-7T94XR stock v2.5.1\n"
    return text + ('Provides: ' + provides + '\n' if provides else '')


def emit(name, depends, payload, provides='', version=VERSION):
    write_package(name, version, payload, {'control': (control(name, depends, version=version, provides=provides).encode(), 0o644)})


def tree(path, destination=''):
    entries = {}
    for file in sorted(path.rglob('*')):
        if file.is_dir():
            continue
        dest = (pathlib.PurePosixPath(destination) / file.relative_to(path)).as_posix()
        data = file.readlink().as_posix() if file.is_symlink() else file.read_bytes()
        mode = file.stat().st_mode & 0o777
        if dest.endswith('.ut') and isinstance(data, bytes):
            data = data.replace(b'{# PKG_VERSION #}', ('25.12+qsdk' + VERSION).encode())
        if dest.endswith('.js') and isinstance(data, bytes):
            data = subprocess.check_output([str(jsmin.resolve())], input=data)
        entries[dest] = (data, mode)
    return entries


# Keep compatible native utilities as separate hash-pinned official 19.07 IPKs.
for package in LOCK['base_packages']:
    original = CACHE / package['filename']
    assert hashlib.sha256(original.read_bytes()).hexdigest() == package['sha256'], package['name']
    ipk = read_archive(original.read_bytes())
    record(original, read_archive(ipk['data.tar.gz'][0]), read_archive(ipk['control.tar.gz'][0])['control'][0].decode())

native = {
    'libiwinfo20181126': (['usr/lib/libiwinfo.so'], 'libc, libgcc, libuci20130104, libubus20210603, libubox20191228, libnl-tiny'),
    'rpcd-mod-iwinfo': (['usr/lib/rpcd/iwinfo.so'], 'libc, rpcd, libiwinfo20181126, libubox20191228, libubus20210603, libuci20130104'),
    'rpcd-mod-luci': (['usr/lib/rpcd/luci.so'], 'libc, rpcd, libiwinfo20181126, libubox20191228, libubus20210603, libuci20130104, libnl-tiny'),
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
    'libiwinfo20181126': '2019-10-16-07315b6f-1',
    'rpcd-mod-iwinfo': '2020-05-26-67c8a3fd-1',
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
    if name == 'libucode20230711':
        payload.update(tree(NATIVE / 'usr/share/licenses/libucode20230711', 'usr/share/licenses/libucode20230711'))
        assert len(payload) == 4
    if name in ('rpcd-mod-iwinfo', 'rpcd-mod-luci'):
        depends = depends.replace('libiwinfo20181126', 'libiwinfo20181126 (= ' + component_versions['libiwinfo20181126'] + ')')
    emit(name, depends, payload, 'libiwinfo' if name == 'libiwinfo20181126' else 'libucode' if name == 'libucode20230711' else '', version=component_versions.get(name, VERSION))

luci_packages = {
    'luci-base': ('modules/luci-base', 'libc, rpcd, rpcd-mod-file, rpcd-mod-luci, rpcd-mod-ucode, cgi-io, ucode, ucode-mod-fs, ucode-mod-log, ucode-mod-uci, ucode-mod-ubus, ucode-mod-math, ucode-mod-html, liblucihttp-ucode'),
    'luci-mod-network': ('modules/luci-mod-network', 'luci-base, rpcd-mod-iwinfo, luci-lib-uqr'),
    'luci-lib-uqr': ('libs/luci-lib-uqr', 'libc'),
    'luci-theme-bootstrap': ('themes/luci-theme-bootstrap', 'luci-base'),
    'luci-app-package-manager': ('applications/luci-app-package-manager', 'luci-base, opkg'),
    'luci-app-sqm': ('applications/luci-app-sqm', 'luci-base, sqm-scripts'),
}
for name, (source, depends) in luci_packages.items():
    path = LUCI / source
    required = re.search(r'^LUCI_DEPENDS:=(.*?)(?=\n[^\t ]|\Z)', (path / 'Makefile').read_text(), re.M | re.S)
    if required:
        assert set(re.findall(r'\+([a-z0-9.+-]+)', required[1])) <= set(depends.split(', ')), name
    payload = tree(path / 'root')
    payload.update(tree(path / 'htdocs', 'www'))
    payload.update(tree(path / 'ucode', 'usr/share/ucode/luci'))
    if name == 'luci-base':
        payload['etc/init.d/ucitrack'] = ((path / 'root/etc/init.d/ucitrack').read_bytes(), 0o755)
    # Config and service setup belong to the small persistent bootstrap.
    payload = {file: data for file, data in payload.items() if not file.startswith('etc/') or file == 'etc/init.d/ucitrack'}
    if name == 'luci-base':
        payload.update(tree(NATIVE / 'usr/lib/ucode/luci', 'usr/lib/ucode/luci'))
        payload['usr/share/ucode/luci/version.uc'] = ((NATIVE / 'usr/share/ucode/luci/version.uc').read_bytes(), 0o644)
    emit(name, depends, payload, 'luci-app-opkg' if name == 'luci-app-package-manager' else '')

network = (HERE / 'root/etc/init.d/network').read_bytes()
wifi = (NETIFD / 'contrib/qsdk/wifi').read_bytes()
driver = (NETIFD / 'examples/wireless/qcawificfg80211.sh').read_bytes()
runtime_payload = {'etc/init.d/network': (network, 0o755), 'sbin/wifi': (wifi, 0o755),
                   'lib/netifd/wireless/qcawificfg80211.sh': (driver, 0o755),
                   'etc/hotplug.d/iface/11-sqm': ((HERE / 'root/etc/hotplug.d/iface/11-sqm').read_bytes(), 0o755)}
emit('luci-qsdk-wn7t94xr-runtime', 'libc, netifd, ubus, jshn', runtime_payload, 'kmod-sched-cake')

manifest = []
for name, version in versions.items():
    path = next(p for p in OUT.glob('*.ipk') if p.name.startswith(name + '_')) if name in packages else next(
        CACHE / p['filename'] for p in LOCK['base_packages'] if p['name'] == name)
    url = FEED_URL + '/' + path.name if name in packages else next(
        'https://archive.openwrt.org/releases/packages-19.07/' + ARCH + '/' + p['feed'] + '/' + p['filename']
        for p in LOCK['base_packages'] if p['name'] == name)
    manifest.append(f'{name} {version} {hashlib.sha256(path.read_bytes()).hexdigest()} {url}\n')
manifest = ''.join(manifest).encode()

original = next(p for p in LOCK['base_packages'] if p['name'] == 'uhttpd')
http = read_archive(read_archive((CACHE / original['filename']).read_bytes())['data.tar.gz'][0])
payload = {name: ((LUCI / 'modules/luci-base/root' / name).read_bytes(), 0o644) for name in ('etc/config/luci',)}
payload['etc/config/uhttpd'] = http['etc/config/uhttpd']
payload['etc/init.d/luci-ram'] = ((HERE / 'root/etc/init.d/luci-ram').read_bytes(), 0o755)
payload['etc/luci-qsdk/ram-packages'] = (manifest, 0o644)
payload['etc/init.d/ucitrack'] = ('/tmp/luci-ram/etc/init.d/ucitrack', 0o755)
payload['etc/init.d/sqm'] = ((HERE / 'root/etc/init.d/sqm').read_bytes(), 0o755)
payload['etc/hotplug.d/iface/11-sqm'] = ('/tmp/luci-ram/etc/hotplug.d/iface/11-sqm', 0o755)
payload['etc/config/sqm'] = (b"config queue 'uplink'\n\toption enabled '0'\n\toption interface 'eth0'\n\toption download '85000'\n\toption upload '10000'\n\toption qdisc 'cake'\n\toption script 'piece_of_cake.qos'\n\toption linklayer 'none'\n", 0o644)
for name in ('usr/sbin/uhttpd', 'usr/bin/ucode', 'usr/libexec/cgi-io', 'usr/lib/liblucihttp.so.0', 'usr/lib/uhttpd_ubus.so'):
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
uci -q delete uhttpd.main.listen_http || true
uci -q delete uhttpd.main.listen_https || true
uci -q delete uhttpd.main.lua_prefix || true
uci -q delete uhttpd.main.ucode_prefix || true
uci add_list uhttpd.main.listen_http=0.0.0.0:8080
uci set uhttpd.main.ubus_prefix=/ubus/
uci set uhttpd.main.redirect_https=0
uci commit uhttpd
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
(OUT / 'Packages').write_text(''.join(packages.values()))
(OUT / 'Packages.gz').write_bytes(gzip.compress((OUT / 'Packages').read_bytes(), mtime=0))
(OUT / 'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in sorted(OUT.glob('*.ipk'))))
(OUT / 'sizes.json').write_text(json.dumps({'preflight_kib': required_kib,
    'boot_download_bytes': sum(s['ipk_bytes'] for name, s in sizes.items() if name not in (PREPARE, 'luci-qsdk-wn7t94xr')),
    'packages': list(sizes.values())}, indent=2) + '\n')
for size in sizes.values():
    print(f"{size['name']}: IPK {size['ipk_bytes']} bytes, files {size['file_bytes']} bytes")
print(f'Custom feed: {len(packages)} IPKs; RAM runtime: {len(manifest.splitlines())} IPKs; bootstrap flash budget {required_kib} KiB')
