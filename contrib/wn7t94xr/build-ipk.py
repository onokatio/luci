#!/usr/bin/env python3
"""Build the device overlay from source forks and SDK-built native modules."""
import gzip
import hashlib
import io
import lzma
import pathlib
import sys
import tarfile

HERE = pathlib.Path(__file__).resolve().parent
LUCI = HERE.parents[1]
NATIVE = pathlib.Path(sys.argv[1])
NETIFD = pathlib.Path(sys.argv[2])
OUT = pathlib.Path(sys.argv[3])
PACKAGE = 'luci-qsdk-wn7t94xr'
VERSION = '2.0.0-4'
BASE_SHA = '0fb0e696c262c5a09df8b39722dcf12a9bf0eee1c92b659ddc3decc5842f51cf'


def archive(entries):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w', format=tarfile.USTAR_FORMAT) as tar:
        directories = {str(parent) for name, _, _ in entries for parent in pathlib.PurePosixPath(name).parents if str(parent) != '.'}
        for directory in sorted(directories):
            item = tarfile.TarInfo(directory + '/')
            item.type, item.mode, item.mtime = tarfile.DIRTYPE, 0o755, 0
            item.uid = item.gid = 0
            item.uname = item.gname = 'root'
            tar.addfile(item)
        for name, payload, mode in sorted(entries):
            item = tarfile.TarInfo(name)
            item.size, item.mode, item.mtime = len(payload), mode, 0
            item.uid = item.gid = 0
            item.uname = item.gname = 'root'
            tar.addfile(item, io.BytesIO(payload))
    return gzip.compress(stream.getvalue(), compresslevel=9, mtime=0)


mapping = {
    'www/luci-static/resources/network.js': 'modules/luci-base/htdocs/luci-static/resources/network.js',
    'www/luci-static/resources/view/network/wireless.js': 'modules/luci-mod-network/htdocs/luci-static/resources/view/network/wireless.js',
    'usr/libexec/rpcd/luci.lua': 'modules/luci-base/root/usr/libexec/rpcd/luci',
    'usr/share/rpcd/acl.d/luci-base.json': 'modules/luci-base/root/usr/share/rpcd/acl.d/luci-base.json',
    'usr/lib/lua/luci/controller/admin/uci.lua': 'modules/luci-base/luasrc/controller/admin/uci.lua',
    'usr/lib/lua/luci/view/header.htm': 'modules/luci-base/luasrc/view/header.htm',
}
entries = [(dest, (LUCI / src).read_bytes(), 0o755 if 'libexec/' in dest else 0o644) for dest, src in mapping.items()]
entries += [('usr/lib/lua/luci/version.lua', b'module "luci.version"\ndistname="OpenWrt"\ndistversion="19.07"\nluciname="LuCI QSDK backend"\nluciversion="git-22.115.68448-712bc8e+qsdk-backend1"\n', 0o644)]
native_files = ['usr/lib/libiwinfo.so', 'usr/lib/lua/iwinfo.so', 'usr/lib/rpcd/luci.so',
                'usr/lib/rpcd/iwinfo.so', 'usr/bin/iwinfo']
for name in native_files:
    binary = (NATIVE / name).read_bytes()
    assert binary[:6] == b'\x7fELF\x01\x01' and binary[18:20] == b'\x28\x00', f'Expected ARM ELF: {name}'
    entries.append((name, binary, 0o755))
entries += [('etc/init.d/network', (HERE / 'root/etc/init.d/network').read_bytes(), 0o755),
            ('sbin/wifi', (NETIFD / 'contrib/qsdk/wifi').read_bytes(), 0o755)]
overlay = lzma.compress(gzip.decompress(archive(entries)), preset=6)
init = (HERE / 'root/etc/init.d/luci-ram').read_bytes()
driver = (NETIFD / 'examples/wireless/qcawificfg80211.sh').read_bytes()

md5 = lambda data: hashlib.md5(data).hexdigest()
network_md5 = md5((HERE / 'root/etc/init.d/network').read_bytes())
wifi_md5 = md5((NETIFD / 'contrib/qsdk/wifi').read_bytes())
driver_md5 = md5(driver)
installed_size = len(overlay) + len(init) + len(driver) + sum(len(payload) for name, payload, _ in entries if name in ('etc/init.d/network', 'sbin/wifi'))

guard = f'''[ -z "$IPKG_INSTROOT" ] && [ "${{PKG_ROOT:-/}}" = / ] || {{ echo 'Install in the live root destination.' >&2; exit 1; }}
[ "$(md5sum /rom/etc/init.d/network | cut -d ' ' -f 1)" = f74e8e77542742781de3e29992bcdb02 ] || {{ echo 'Unsupported vendor network service.' >&2; exit 1; }}
[ "$(md5sum /rom/sbin/wifi | cut -d ' ' -f 1)" = 0f9e16e177b75c05e31d6300e96faa8e ] || {{ echo 'Unsupported native Wireless controller.' >&2; exit 1; }}
[ "$(sha256sum /root/luci-ram.tar.xz | cut -d ' ' -f 1)" = {BASE_SHA} ] || {{ echo 'The verified RAM LuCI base bundle is required.' >&2; exit 1; }}
case "$(md5sum /etc/init.d/network | cut -d ' ' -f 1)" in f74e8e77542742781de3e29992bcdb02|b266ca9d7d4ad43346f8d5f8e6209877|{network_md5}) ;; *) echo 'Network service changed; refusing to replace it.' >&2; exit 1;; esac
case "$(md5sum /sbin/wifi | cut -d ' ' -f 1)" in 0f9e16e177b75c05e31d6300e96faa8e|{wifi_md5}) ;; *) echo 'Wireless entry point changed; refusing to replace it.' >&2; exit 1;; esac
[ ! -e /lib/wifi/cust/wireless_backup ] && [ ! -e /tmp/.qca-wireless-reloading ] || {{ echo 'Wait for the pending native Wireless change.' >&2; exit 1; }}
'''
preinst = '#!/bin/sh\n' + guard + f'''case "$(md5sum /etc/init.d/luci-ram | cut -d ' ' -f 1)" in 49575f6d84b6b408c1197b6205cd4717|{md5((HERE / 'luci-ram.base').read_bytes())}|{md5(init)}) ;; *) echo 'RAM LuCI startup changed; refusing to replace it.' >&2; exit 1;; esac
# opkg does not credit the old compressed archive during an upgrade.
reclaim=0
for old in /usr/share/luci-qsdk/overlay.tar.gz /usr/share/luci-qsdk/overlay.tar.xz; do
 [ ! -f "$old" ] || reclaim=$((reclaim + $(wc -c < "$old")))
done
needed=$(({installed_size // 1024 + 1} + 32 - reclaim / 1024))
[ "$(df -k /overlay | awk 'NR==2 {{print $4}}')" -ge "$needed" ] || {{ echo 'Insufficient overlay space including the replaced archive and 32 KiB reserve.' >&2; exit 1; }}
exit 0
'''

reset_ram = '''/etc/init.d/luci-ram stop || exit 1
for target in /usr/share/luci /www/luci-static /usr/lib/rpcd; do
 if grep -qs " $target " /proc/mounts; then umount "$target" || exit 1; fi
done
rm -rf /tmp/wn7-root /tmp/luci-abi /tmp/luci-ipks /tmp/luci-stack
rm -f /tmp/luci-ram.ready /tmp/luci-indexcache /tmp/luci-modulecache/*
/etc/init.d/luci-ram start || exit 1
'''
postinst = '#!/bin/sh\n' + guard + '''set -e
for target in etc/init.d/network sbin/wifi; do
 tar -xOJf /usr/share/luci-qsdk/overlay.tar.xz "$target" > "/$target.qsdk-new"
 chmod 755 "/$target.qsdk-new"
 mv "/$target.qsdk-new" "/$target"
done
''' + reset_ram + '''# Restart only the existing network service to register its new wireless driver.
/etc/init.d/network restart
echo 'Installed QSDK netifd/iwinfo compatibility and standard LuCI Wireless support.'
exit 0
'''
prerm = '#!/bin/sh\n[ "$PKG_UPGRADE" = 1 ] && exit 0\n' + guard + f'''[ "$(md5sum /lib/netifd/wireless/qcawificfg80211.sh | cut -d ' ' -f 1)" = {driver_md5} ] || {{ echo 'Wireless driver changed; refusing removal.' >&2; exit 1; }}
exit 0
'''
# Keep the existing single-RPCD RAM bootstrap working after uninstall.
base_init = (HERE / 'luci-ram.base').read_text()
postrm = '#!/bin/sh\n[ "$PKG_UPGRADE" = 1 ] && exit 0\n' + f'''set -e
[ -z "$IPKG_INSTROOT" ] || exit 0
[ "$(md5sum /etc/init.d/network | cut -d ' ' -f 1)" = {network_md5} ]
[ "$(md5sum /sbin/wifi | cut -d ' ' -f 1)" = {wifi_md5} ]
cp /rom/etc/init.d/network /etc/init.d/network
cp /rom/sbin/wifi /sbin/wifi
cat > /etc/init.d/luci-ram <<'WN7_BASE_INIT'
{base_init}WN7_BASE_INIT
chmod 755 /etc/init.d/luci-ram
''' + reset_ram + '''/etc/init.d/network restart
echo 'Restored the native network/Wireless controller and original RAM LuCI.'
'''
control = f'''Package: {PACKAGE}
Version: {VERSION}
Architecture: arm_cortex-a7_neon-vfpv4
Depends: rpcd, netifd, ubus, jshn, libnl-tiny
Section: luci
Priority: optional
Maintainer: onokatio
License: Apache-2.0 AND GPL-2.0-only
Description: QSDK netifd/iwinfo integration for WN-7T94XR v2.5.1
 Uses native firmware/driver control, standard Wireless RPC and the verified
 RAM LuCI base. Includes AP lifecycle, MLO-aware forms and native scanning.
Installed-Size: {installed_size}
'''
hooks = [('control', control.encode(), 0o644)] + [(name, text.encode(), 0o755) for name, text in
         [('preinst', preinst), ('postinst', postinst), ('prerm', prerm), ('postrm', postrm)]]
data = archive([('usr/share/luci-qsdk/overlay.tar.xz', overlay, 0o644),
                ('etc/init.d/luci-ram', init, 0o755),
                ('lib/netifd/wireless/qcawificfg80211.sh', driver, 0o755)])
OUT.mkdir(parents=True, exist_ok=True)
ipk = OUT / f'{PACKAGE}_{VERSION}_arm_cortex-a7_neon-vfpv4.ipk'
ipk.write_bytes(archive([('debian-binary', b'2.0\n', 0o644), ('control.tar.gz', archive(hooks), 0o644), ('data.tar.gz', data, 0o644)]))
(OUT / 'overlay.tar.xz').write_bytes(overlay)
(OUT / 'SHA256SUMS').write_text(hashlib.sha256(ipk.read_bytes()).hexdigest() + '  ' + ipk.name + '\n')
print(f'{ipk.name}: {ipk.stat().st_size} bytes, overlay {len(overlay)} bytes')
