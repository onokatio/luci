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
VERSION = '3.6.0-1'
SUFFIX = '+qsdk3.4.0'
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


mapping = {
    'luci-mod-network': {
        'www/luci-static/resources/view/network/wireless.js': 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js',
        'www/luci-static/resources/view/network/switch.js': 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/switch.js',
    },
}
for package in LOCK['base_packages']:
    original = CACHE / package['filename']
    assert hashlib.sha256(original.read_bytes()).hexdigest() == package['sha256'], package['name']
    ipk = read_archive(original.read_bytes())
    payload, hooks = read_archive(ipk['data.tar.gz'][0]), read_archive(ipk['control.tar.gz'][0])
    if package['name'] not in mapping:
        record(original, payload, hooks['control'][0].decode())
        continue
    for dest, source in mapping[package['name']].items():
        assert dest in payload
        data = (LUCI / source).read_bytes()
        if dest.endswith('.js'):
            data = subprocess.check_output([str(jsmin.resolve())], input=data)
        payload[dest] = (data, payload[dest][1])
    version = package['version'] + SUFFIX
    control = re.sub(r'^Version: .*$', 'Version: ' + version, hooks['control'][0].decode(), flags=re.M)
    hooks['control'] = (control.encode(), 0o644)
    hooks['preinst'] = (b'''#!/bin/sh
[ -z "$IPKG_INSTROOT" ] || exit 0
for target in /usr/share/luci /www/luci-static /usr/lib/rpcd; do
 if grep -qs " $target " /proc/mounts; then
  echo 'Migrate the old RAM LuCI before installing the flash packages.' >&2
  exit 1
 fi
done
''', 0o755)
    write_package(package['name'], version, payload, hooks)

native = {
    'libiwinfo20181126': ('2019-10-16-07315b6f-1' + SUFFIX, 'usr/lib/libiwinfo.so', 'libc, libgcc, libuci20130104, libubus20210603, libubox20191228, libnl-tiny'),
    'libiwinfo-lua': ('2019-10-16-07315b6f-1' + SUFFIX, 'usr/lib/lua/iwinfo.so', 'libc, liblua5.1.5'),
    'rpcd-mod-iwinfo': ('2020-05-26-67c8a3fd-1' + SUFFIX, 'usr/lib/rpcd/iwinfo.so', 'libc, rpcd, libubox20191228, libubus20210603, libuci20130104'),
    'rpcd-mod-luci': ('20210614-1' + SUFFIX, 'usr/lib/rpcd/luci.so', 'libc, rpcd, libubox20191228, libubus20210603, libuci20130104, libnl-tiny'),
}
for name, (version, filename, depends) in native.items():
    binary = (NATIVE / filename).read_bytes()
    assert binary[:6] == b'\x7fELF\x01\x01' and binary[18:20] == b'\x28\x00', filename
    if name != 'libiwinfo20181126':
        depends += ', libiwinfo20181126 (= ' + native['libiwinfo20181126'][0] + ')'
    control = f'''Package: {name}
Version: {version}
Architecture: {ARCH}
Depends: {depends}
Section: libs
Priority: optional
Maintainer: onokatio
License: GPL-2.0-only AND ISC
Description: QSDK network backend for WN-7T94XR v2.5.1
'''
    if name == 'libiwinfo20181126':
        control += 'Provides: libiwinfo\n'
    hooks = {'control': (control.encode(), 0o644)}
    hooks['postrm'] = (f'''#!/bin/sh
[ "$PKG_UPGRADE" = 1 ] && exit 0
[ -z "$IPKG_INSTROOT" ] || exit 0
[ ! -e /rom/{filename} ] || cp /rom/{filename} /{filename}
'''.encode(), 0o755)
    write_package(name, version, {filename: (binary, 0o755)}, hooks)

network = (HERE / 'root/etc/init.d/network').read_bytes()
wifi = (NETIFD / 'contrib/qsdk/wifi').read_bytes()
driver = (NETIFD / 'examples/wireless/qcawificfg80211.sh').read_bytes()
runtime_payload = {'etc/init.d/network': (network, 0o755),
                   'sbin/wifi': (wifi, 0o755),
                   'lib/netifd/wireless/qcawificfg80211.sh': (driver, 0o755)}
base = next(p for p in LOCK['base_packages'] if p['name'] == 'luci-base')
base_ipk = read_archive((CACHE / base['filename']).read_bytes())
version_file = read_archive(base_ipk['data.tar.gz'][0])['usr/lib/lua/luci/version.lua'][0]
# Give changed Javascript a new cache key while downloading the unchanged official base.
runtime_payload['usr/lib/lua/luci/version.lua'] = (version_file +
    ('\nluciversion = luciversion .. "+qsdk' + VERSION + '"\n').encode(), 0o644)
runtime_control = f'''Package: luci-qsdk-wn7t94xr-runtime
Version: {VERSION}
Architecture: {ARCH}
Depends: libc, netifd, ubus, jshn
Section: luci
License: GPL-2.0-only
Description: RAM-loaded QSDK network integration for WN-7T94XR
'''
write_package('luci-qsdk-wn7t94xr-runtime', VERSION, runtime_payload,
              {'control': (runtime_control.encode(), 0o644)})

manifest = []
for name, version in versions.items():
    path = next(p for p in OUT.glob('*.ipk') if p.name.startswith(name + '_')) if name in packages else next(
        CACHE / p['filename'] for p in LOCK['base_packages'] if p['name'] == name)
    url = FEED_URL + '/' + path.name if name in packages else next(
        'https://archive.openwrt.org/releases/packages-19.07/' + ARCH + '/' + p['feed'] + '/' + p['filename']
        for p in LOCK['base_packages'] if p['name'] == name)
    manifest.append(f'{name} {version} {hashlib.sha256(path.read_bytes()).hexdigest()} {url}\n')
manifest = ''.join(manifest).encode()

original = next(p for p in LOCK['base_packages'] if p['name'] == 'luci-base')
base = read_archive(read_archive((CACHE / original['filename']).read_bytes())['data.tar.gz'][0])
original = next(p for p in LOCK['base_packages'] if p['name'] == 'uhttpd')
http = read_archive(read_archive((CACHE / original['filename']).read_bytes())['data.tar.gz'][0])
payload = {name: base[name] for name in ('etc/config/luci', 'etc/config/ucitrack')}
payload['etc/config/uhttpd'] = http['etc/config/uhttpd']
payload['etc/init.d/luci-ram'] = ((HERE / 'root/etc/init.d/luci-ram').read_bytes(), 0o755)
payload['etc/luci-qsdk/ram-packages'] = (manifest, 0o644)
payload['sbin/luci-reload'] = ('/tmp/luci-ram/sbin/luci-reload', 0o755)
for name in ('usr/sbin/uhttpd', 'usr/libexec/cgi-io', 'usr/lib/liblucihttp.so', 'usr/lib/liblucihttp.so.0', 'usr/lib/uhttpd_ubus.so'):
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
uci add_list uhttpd.main.listen_http=0.0.0.0:8080
uci set uhttpd.main.ubus_prefix=/ubus/
uci set uhttpd.main.redirect_https=0
uci commit uhttpd
/etc/init.d/luci-ram enable
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
         'conffiles': (b'/etc/config/luci\n/etc/config/ucitrack\n/etc/config/uhttpd\n', 0o644)}
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
