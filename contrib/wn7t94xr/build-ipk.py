#!/usr/bin/env python3
"""Build persistent dependencies and a downloaded, official RAM LuCI base."""
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
VERSION = '3.2.1-1'
SUFFIX = '+qsdk3.1.1'
PREPARE = 'luci-qsdk-wn7t94xr-prepare'
PREPARE_PATH = 'usr/libexec/luci-qsdk-prepare'
PREPARE_KIB = 16
FEED_KEY = 'f82c00f7b71cbbcc'
FEED_URL = 'https://github.com/onokatio/luci/releases/download/v' + VERSION
LOCK = json.loads((HERE / 'sources.json').read_text())
RAM_BASE = LOCK['ram_base']
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
    },
}
for package in LOCK['base_packages']:
    original = CACHE / package['filename']
    assert hashlib.sha256(original.read_bytes()).hexdigest() == package['sha256'], package['name']
    ipk = read_archive(original.read_bytes())
    payload, hooks = read_archive(ipk['data.tar.gz'][0]), read_archive(ipk['control.tar.gz'][0])
    if package['name'] == 'luci-base':
        assert original.name == RAM_BASE['filename'] and package['sha256'] == RAM_BASE['sha256']
        assert original.stat().st_size == RAM_BASE['size']
        init = (HERE / 'root/etc/init.d/luci-base-ram').read_text()
        init = init.replace('@BASE_SHA@', RAM_BASE['sha256']).replace('@BASE_URL@', RAM_BASE['url'])
        base_payload = {name: payload[name] for name in [
            'etc/config/luci', 'etc/config/ucitrack', 'lib/upgrade/keep.d/luci-base']}
        base_payload['etc/init.d/luci-base-ram'] = (init.encode(), 0o755)
        for name in ['etc/init.d/ucitrack', 'sbin/luci-reload']:
            base_payload[name] = ('/tmp/luci-base/' + name, 0o755)
        control = hooks['control'][0].decode()
        version = package['version'] + '+ram3.2.1'
        control = re.sub(r'^Version: .*$', 'Version: ' + version, control, flags=re.M)
        control = re.sub(r'^Depends: (.*)$', r'Depends: \1, curl', control, flags=re.M)
        base_hooks = {'control': (control.encode(), 0o644),
                      'conffiles': (b'/etc/config/luci\n/etc/config/ucitrack\n', 0o644)}
        base_hooks['postinst'] = (b'''#!/bin/sh
set -e
[ -z "$IPKG_INSTROOT" ] || exit 0
[ "$(readlink /etc/rc.d/S11luci-base-ram)" != ../init.d/luci-base-ram ] || rm /etc/rc.d/S11luci-base-ram
/etc/init.d/luci-base-ram enable
/etc/init.d/luci-base-ram restart || logger -t luci-base-ram 'LuCI unavailable; retry with luci-base-ram start when online'
''', 0o755)
        base_hooks['prerm'] = (b'''#!/bin/sh
[ "$PKG_UPGRADE" = 1 ] && exit 0
[ -z "$IPKG_INSTROOT" ] || exit 0
/etc/init.d/luci-base-ram stop || exit 1
/etc/init.d/luci-base-ram disable
''', 0o755)
        write_package(package['name'], version, base_payload, base_hooks)
        sizes[package['name']]['boot_download_bytes'] = RAM_BASE['size']
        continue
    if package['name'] not in mapping:
        record(original, payload, hooks['control'][0].decode())
        continue
    for dest, source in mapping[package['name']].items():
        assert dest in payload
        data = (LUCI / source).read_bytes()
        if dest.endswith('.js'):
            data = subprocess.check_output([str(jsmin.resolve())], input=data)
        payload[dest] = (data, payload[dest][1])
    version = package['version'] + '+qsdk3.1.0'
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
Description: QSDK Wireless backend for WN-7T94XR v2.5.1
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
payload = {'usr/share/luci-qsdk/network': (network, 0o755),
           'usr/share/luci-qsdk/wifi': (wifi, 0o755),
           'lib/netifd/wireless/qcawificfg80211.sh': (driver, 0o755)}
md5 = lambda data: hashlib.md5(data).hexdigest()
# The live flash install used 26 KiB beyond the per-file estimate; allow 32 KiB plus a 32 KiB reserve.
required_kib = (sum(s['estimated_ubifs_bytes'] for s in sizes.values()) + flash_bytes(payload) + 32768 + 1023) // 1024 + 32 + PREPARE_KIB
# The 3.1.0 payloads are unchanged; replacing their package hooks frees the same data budget.
previous_versions = {name: version.replace('+qsdk3.1.1', '+qsdk3.1.0').replace('+ram3.2.1', '+ram3.2.0')
                     for name, version in versions.items()}
credits = ' '.join(name + ':' + versions[name] + ':' + previous_versions[name] + ':' + str(size['estimated_ubifs_bytes'] // 1024)
                   for name, size in sizes.items())
credits += f' {PREPARE}:{VERSION}:{VERSION}:{PREPARE_KIB}'
managed = ('etc/init.d/network sbin/wifi etc/config/rpcd etc/config/uhttpd '
           'etc/init.d/luci-ram etc/rc.d/S99luci-ram etc/rc.d/K10luci-ram '
           'root/luci-ram.tar.xz usr/share/luci-qsdk/overlay.tar.xz '
           'usr/share/rpcd/acl.d/luci-base.json etc/opkg/distfeeds.conf.before-dropbear '
           'root/luci-base.tar.xz etc/opkg/distfeeds.conf')
guard = f'''[ -z "$IPKG_INSTROOT" ] && [ "${{PKG_ROOT:-/}}" = / ] || {{ echo 'Install in the live root destination.' >&2; exit 1; }}
[ "$(md5sum /rom/etc/init.d/network | cut -d ' ' -f 1)" = f74e8e77542742781de3e29992bcdb02 ] || {{ echo 'Unsupported vendor network service.' >&2; exit 1; }}
[ "$(md5sum /rom/sbin/wifi | cut -d ' ' -f 1)" = 0f9e16e177b75c05e31d6300e96faa8e ] || {{ echo 'Unsupported native Wireless controller.' >&2; exit 1; }}
[ "$(md5sum /etc/init.d/rpcd | cut -d ' ' -f 1)" = 1f88f46a68f93a38f5d0ebdd1c71e89a ] || {{ echo 'Keep the native RPC service.' >&2; exit 1; }}
case "$(md5sum /etc/init.d/network | cut -d ' ' -f 1)" in f74e8e77542742781de3e29992bcdb02|b266ca9d7d4ad43346f8d5f8e6209877|{md5(network)}) ;; *) echo 'Network service changed; refusing replacement.' >&2; exit 1;; esac
case "$(md5sum /sbin/wifi | cut -d ' ' -f 1)" in 0f9e16e177b75c05e31d6300e96faa8e|{md5(wifi)}) ;; *) echo 'Wireless entry point changed; refusing replacement.' >&2; exit 1;; esac
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
prepare = '#!/bin/sh\nset -e\n' + guard + auth + f'''if [ -f /tmp/luci-qsdk-install/prepared ]; then
 [ ! -L /tmp/luci-qsdk-install ] && [ "$(stat -c '%u:%a' /tmp/luci-qsdk-install)" = 0:700 ] || exit 1
 [ "$(cat /tmp/luci-qsdk-install/prepared)" = {VERSION} ] || exit 1
 exit 0
fi
if ! usable_login; then
 hash="$(awk -F: '$1=="root" {{print $2}}' /etc/shadow)"
 case "$hash" in ''|'!'*|'*'*) echo 'Set a root password before installing LuCI.' >&2; exit 1;; esac
 [ -z "$(uci -q get rpcd.qsdk_luci)" ] || exit 1
fi
reclaim=0
if [ -e /etc/init.d/luci-ram ]; then
 case "$(md5sum /etc/init.d/luci-ram | cut -d ' ' -f 1)" in 49575f6d84b6b408c1197b6205cd4717|76f55be03e15adeb80ee24507c1cc7a1|1f58070a285da336c45817415df6f11b) ;; *) echo 'Unknown RAM startup; refusing migration.' >&2; exit 1;; esac
 [ "$(sha256sum /root/luci-ram.tar.xz | cut -d ' ' -f 1)" = 0fb0e696c262c5a09df8b39722dcf12a9bf0eee1c92b659ddc3decc5842f51cf ] || exit 1
 for file in /root/luci-ram.tar.xz /usr/share/luci-qsdk/overlay.tar.xz /etc/init.d/luci-ram; do
  [ ! -f "$file" ] || reclaim=$((reclaim + $(wc -c < "$file")))
 done
fi
old_base=0
if [ ! -L /root/luci-base.tar.xz ] && [ -f /root/luci-base.tar.xz ] && [ "$(sha256sum /root/luci-base.tar.xz | cut -d ' ' -f 1)" = d92fba712b3aea72977bcd8fb94bc873663b9adbf16e683099037a0a235ef56d ]; then
 old_base=1
 reclaim=$((reclaim + $(wc -c < /root/luci-base.tar.xz)))
fi
old_feeds=0
if [ -f /etc/opkg/distfeeds.conf.before-dropbear ] && [ "$(md5sum /etc/opkg/distfeeds.conf.before-dropbear | cut -d ' ' -f 1)" = 42630a2cf0641aebf947488d21f57284 ]; then
 old_feeds=1
 reclaim=$((reclaim + $(wc -c < /etc/opkg/distfeeds.conf.before-dropbear)))
fi
stock_feeds=0
if [ ! -L /etc/opkg/distfeeds.conf ] && [ -f /etc/opkg/distfeeds.conf ] && [ "$(md5sum /etc/opkg/distfeeds.conf | cut -d ' ' -f 1)" = 42630a2cf0641aebf947488d21f57284 ]; then stock_feeds=1; fi
required={required_kib}
for credit in {credits}; do
 name="${{credit%%:*}}"; rest="${{credit#*:}}"; version="${{rest%%:*}}"; rest="${{rest#*:}}"; previous="${{rest%:*}}"; kib="${{rest##*:}}"
 installed="$(sed -n 's/^Version: //p' "/usr/lib/opkg/info/$name.control" 2>/dev/null || true)"
 if [ -n "$installed" ] && {{ [ "$installed" = "$version" ] || [ "$installed" = "$previous" ]; }}; then
  required=$((required - kib))
 fi
done
[ "$required" -ge 32 ] || required=32
for replacement in libiwinfo20181126:usr/lib/libiwinfo.so:11 libiwinfo-lua:usr/lib/lua/iwinfo.so:5; do
 name="${{replacement%%:*}}"; rest="${{replacement#*:}}"; file="${{rest%:*}}"; kib="${{rest##*:}}"
 # Only reclaim verified vendor files already copied to UBIFS, never read-only ROM files.
 if [ -f "/overlay/upper/$file" ] && [ ! -L "/overlay/upper/$file" ] && cmp -s "/$file" "/rom/$file"; then required=$((required - kib)); fi
done
[ "$required" -ge 32 ] || required=32
available="$(df -k /overlay | awk 'NR==2 {{print $4}}')"
[ "$((available + reclaim / 1024))" -ge "$required" ] || {{ echo "Overlay needs $required KiB including reserve; only $available KiB plus at most $((reclaim / 1024)) KiB reclaimable. No files changed." >&2; exit 1; }}
umask 077
if [ ! -d /tmp/luci-qsdk-install ]; then
 mkdir /tmp/luci-qsdk-install
 printf '%s\n' {VERSION} > /tmp/luci-qsdk-install/version
 touch /tmp/luci-qsdk-install/files /tmp/luci-qsdk-install/absent
 for file in {managed}; do
  if [ -e "/$file" ] || [ -L "/$file" ]; then echo "$file" >> /tmp/luci-qsdk-install/files
  else echo "$file" >> /tmp/luci-qsdk-install/absent; fi
 done
 tar -czf /tmp/luci-qsdk-install/previous.tar.gz -C / -T /tmp/luci-qsdk-install/files
else
 [ ! -L /tmp/luci-qsdk-install ] && [ "$(stat -c '%u:%a' /tmp/luci-qsdk-install)" = 0:700 ] || exit 1
 [ "$(cat /tmp/luci-qsdk-install/version)" = {VERSION} ] && [ -f /tmp/luci-qsdk-install/previous.tar.gz ] || {{ echo 'Recover the existing installation backup first.' >&2; exit 1; }}
fi
[ "$old_base" != 1 ] || rm /root/luci-base.tar.xz
if [ -e /etc/init.d/luci-ram ]; then
 /etc/init.d/luci-ram stop
 /etc/init.d/luci-ram disable
 for target in /usr/share/luci /www/luci-static /usr/lib/rpcd; do
  if grep -qs " $target " /proc/mounts; then
   [ "/tmp/wn7-root$target" -ef "$target" ] || {{ echo "Unknown mount at $target." >&2; exit 1; }}
   umount "$target"
  fi
 done
 # opkg still removes obsolete files owned by the previous package version.
 rm -f /root/luci-ram.tar.xz /tmp/luci-ram.ready
 [ ! -f /usr/share/luci-qsdk/overlay.tar.xz ] || : > /usr/share/luci-qsdk/overlay.tar.xz
fi
/etc/init.d/rpcd stop
[ "$old_feeds" != 1 ] || rm -f /etc/opkg/distfeeds.conf.before-dropbear
if [ "$stock_feeds" = 1 ]; then
 : > /etc/opkg/distfeeds.conf
 for feed in base luci packages routing; do
  echo "src/gz openwrt_$feed https://archive.openwrt.org/releases/packages-19.07/{ARCH}/$feed" >> /etc/opkg/distfeeds.conf
 done
fi
mount -o remount,compr=zlib /overlay
sync
available="$(df -k /overlay | awk 'NR==2 {{print $4}}')"
[ "$available" -ge "$required" ] || {{ echo "Overlay needs $required KiB including reserve; $available KiB available. Recover the saved RAM setup before rebooting." >&2; exit 1; }}
printf '%s\n' {VERSION} > /tmp/luci-qsdk-install/prepared
sync
echo 'Prepared direct overlay installation; rollback files are in /tmp/luci-qsdk-install.'
'''
prepare_control = f'''Package: {PREPARE}
Version: {VERSION}
Architecture: {ARCH}
Depends: libc, opkg, uci, usign
Section: luci
Priority: optional
Maintainer: onokatio
License: GPL-2.0-only
Description: Device preparation and signed online feed for WN-7T94XR LuCI
 Validates the device, login and flash budget before migrating the old RAM setup.
'''
prepare_payload = {PREPARE_PATH: (prepare.encode(), 0o755),
                   'etc/opkg/wn7t94xr-luci.conf': (f'src/gz wn7t94xr_luci {FEED_URL}\n'.encode(), 0o644),
                   'etc/opkg/keys/' + FEED_KEY: ((HERE / 'feed.pub').read_bytes(), 0o644)}
prepare_hooks = {'control': (prepare_control.encode(), 0o644), 'preinst': (prepare.encode(), 0o755)}
assert flash_bytes(prepare_payload) + flash_bytes(prepare_hooks) <= PREPARE_KIB * 1024
write_package(PREPARE, VERSION, prepare_payload, prepare_hooks)
preinst = f'''#!/bin/sh
set -e
[ -x /{PREPARE_PATH} ] && [ "$(sed -n 's/^Version: //p' /usr/lib/opkg/info/{PREPARE}.control)" = {VERSION} ] || {{ echo 'Install {PREPARE} {VERSION} first.' >&2; exit 1; }}
exec /{PREPARE_PATH}
'''
postinst = '#!/bin/sh\nset -e\n' + guard + auth + '''available="$(df -k /overlay | awk 'NR==2 {print $4}')"
# UBIFS temporarily reserves dirty data at its uncompressed size until journal commit.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
 [ "$available" -ge 32 ] && break
 sync
 sleep 1
 available="$(df -k /overlay | awk 'NR==2 {print $4}')"
done
[ "$available" -ge 32 ] || { echo "Only $available KiB available after unpacking. Do not reboot; recover the installation backup." >&2; exit 1; }
/etc/init.d/luci-base-ram enable
/etc/init.d/luci-base-ram start || logger -t luci-base-ram 'LuCI unavailable; router services continue'
cp /usr/share/luci-qsdk/network /etc/init.d/network
cp /usr/share/luci-qsdk/wifi /sbin/wifi
chmod 755 /etc/init.d/network /sbin/wifi
if ! usable_login; then
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
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/*
/etc/init.d/rpcd enable
/etc/init.d/rpcd restart
/etc/init.d/uhttpd enable
/etc/init.d/uhttpd restart
/etc/init.d/network restart
sync
rm -f /tmp/luci-qsdk-install/prepared
echo 'Installed RAM LuCI base with persistent addons on port 8080.'
echo 'Installation backup is in /tmp/luci-qsdk-install until the next reboot.'
'''
prerm = '#!/bin/sh\n[ "$PKG_UPGRADE" = 1 ] && exit 0\nset -e\n' + guard + f'''[ "$(md5sum /etc/init.d/network | cut -d ' ' -f 1)" = {md5(network)} ]
[ "$(md5sum /sbin/wifi | cut -d ' ' -f 1)" = {md5(wifi)} ]
cp /rom/etc/init.d/network /etc/init.d/network
cp /rom/sbin/wifi /sbin/wifi
'''
postrm = '''#!/bin/sh
[ "$PKG_UPGRADE" = 1 ] && exit 0
[ -z "$IPKG_INSTROOT" ] || exit 0
/etc/init.d/network restart
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache/*
echo 'Restored vendor network entry points; separate LuCI packages remain installed.'
'''
depends = ['libc', 'libgcc', 'netifd', 'ubus', 'jshn', 'opkg', PREPARE + ' (= ' + VERSION + ')']
depends += [name + ' (= ' + versions[name] + ')' for name in [
    'luci-base', 'luci-mod-network', 'libiwinfo20181126', 'libiwinfo-lua', 'rpcd-mod-iwinfo', 'rpcd-mod-luci']]
depends += ['luci-theme-bootstrap', 'luci-app-opkg', 'uhttpd', 'uhttpd-mod-ubus']
control = f'''Package: luci-qsdk-wn7t94xr
Version: {VERSION}
Architecture: {ARCH}
Depends: {', '.join(depends)}
Section: luci
Priority: optional
Maintainer: onokatio
License: GPL-2.0-only
Description: Persistent QSDK extensions with an official LuCI base in RAM
 Downloads the base into RAM at each boot; keeps addons on UBIFS with standard OverlayFS.
 Keeps vendor wireless firmware, drivers and calibration data.
'''
hooks = {'control': (control.encode(), 0o644)}
hooks.update({name: (data.encode(), 0o755) for name, data in [
    ('preinst', preinst), ('postinst', postinst), ('prerm', prerm), ('postrm', postrm)]})
write_package('luci-qsdk-wn7t94xr', VERSION, payload, hooks)
(OUT / 'Packages').write_text(''.join(packages.values()))
(OUT / 'Packages.gz').write_bytes(gzip.compress((OUT / 'Packages').read_bytes(), mtime=0))
(OUT / 'SHA256SUMS').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n' for p in sorted(OUT.glob('*.ipk'))))
(OUT / 'sizes.json').write_text(json.dumps({'preflight_kib': required_kib, 'packages': list(sizes.values())}, indent=2) + '\n')
for size in sizes.values():
    print(f"{size['name']}: IPK {size['ipk_bytes']} bytes, files {size['file_bytes']} bytes")
print(f'Custom feed: {len(packages)} IPKs; complete dependency set: {len(sizes)} IPKs; estimated flash budget including reserve {required_kib} KiB')
