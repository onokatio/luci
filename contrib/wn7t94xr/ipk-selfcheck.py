#!/usr/bin/env python3
"""Check separate IPK ownership, dependency closure, hashes and native ABI inputs."""
import hashlib
import io
import json
import pathlib
import re
import subprocess
import sys
import tarfile
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
LOCK = json.loads((HERE / 'sources.json').read_text())
records, owners = {}, {}
OUT, CACHE = map(pathlib.Path, sys.argv[1:])
custom_names = set(LOCK['luci_packages']) | { 'libiwinfo20181126', 'libiwinfo-lua',
                'rpcd-mod-iwinfo', 'rpcd-mod-luci', 'luci-qsdk-wn7t94xr-runtime',
                'luci-qsdk-wn7t94xr', 'luci-qsdk-wn7t94xr-prepare'}
persistent = {'luci-qsdk-wn7t94xr', 'luci-qsdk-wn7t94xr-prepare'}
published = list(OUT.glob('*.ipk'))
assert len(published) == len(custom_names)
official = [CACHE / p['filename'] for p in LOCK['base_packages'] if p['name'] not in custom_names]


def unpack(raw):
    with tarfile.open(fileobj=io.BytesIO(raw)) as tar:
        result = {}
        names = {m.name.removeprefix('./'): m for m in tar}
        for name, item in names.items():
            path = pathlib.PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts
            if item.isdir():
                continue
            assert item.isfile() or item.issym(), name
            assert all(str(parent) in names and names[str(parent)].isdir()
                       for parent in path.parents if str(parent) != '.')
            if item.issym():
                assert '/tmp/wn7-' not in item.linkname
                result[name] = item.linkname
            else:
                result[name] = tar.extractfile(item).read()
        return result


for filename in published + official:
    path = pathlib.Path(filename)
    ipk = unpack(path.read_bytes())
    assert set(ipk) == {'debian-binary', 'control.tar.gz', 'data.tar.gz'}
    assert ipk['debian-binary'] == b'2.0\n'
    payload, hooks = unpack(ipk['data.tar.gz']), unpack(ipk['control.tar.gz'])
    fields = dict(re.findall(r'^([A-Za-z-]+): (.*)$', hooks['control'].decode(), re.M))
    name = fields['Package']
    assert name not in records
    records[name] = (fields, payload, path)
    for file, data in payload.items():
        if name in persistent:
            assert file not in owners, f'Duplicate bootstrap ownership: {file}'
            owners[file] = name
            assert not isinstance(data, bytes) or not data.startswith(b'\x7fELF'), file
        if isinstance(data, bytes) and data.startswith(b'\x7fELF'):
            assert data[:6] == b'\x7fELF\x01\x01' and data[18:20] == b'\x28\x00', file
    for file, data in hooks.items():
        if file in ('preinst', 'postinst', 'prerm', 'postrm'):
            subprocess.run(['sh', '-n'], input=data, check=True)

assert len(records) == len(LOCK['base_packages']) + len(custom_names)
assert {name for name, (_, _, path) in records.items() if path.parent == OUT} == custom_names
assert set(re.findall(r'^Package: (.*)$', (OUT / 'Packages').read_text(), re.M)) == custom_names
available = set(records) | set(LOCK['rom_packages']) | {'libc', 'libgcc', 'libpthread', 'opkg', 'netifd', 'ubus', 'jshn'}
for fields, _, _ in records.values():
    for dependency in fields['Depends'].split(', '):
        match = re.fullmatch(r'([a-zA-Z0-9.+-]+)(?: \(= ([^()]+)\))?', dependency)
        assert match and (match[1] in available or match[1] == "kmod-sched-cake"), dependency
        if match[2]:
            assert records[match[1]][0]['Version'] == match[2], dependency
        if fields['Package'] in persistent:
            assert match[1] in LOCK['rom_packages'] or match[1] in persistent | {'libc', 'opkg', 'netifd', 'ubus', 'jshn'}

for original in LOCK['base_packages']:
    name = original['name']
    fields, payload, path = records[name]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == original['sha256'], name

fields, payload, path = records['luci-mod-network']
assert b'qca_next_ifname' in payload['www/luci-static/resources/view/network/wireless.js']
assert b'rmempty=false' in payload['www/luci-static/resources/view/network/switch.js']
assert b'getAccelerationStatus' in payload['www/luci-static/resources/view/network/acceleration.js']
acl = json.loads(payload['usr/share/rpcd/acl.d/luci-qsdk-acceleration.json'])
assert acl['luci-qsdk-acceleration']['write']['file'] == {'/etc/init.d/qca-nss-ecm restart': ['exec']}
assert b'network/acceleration' in payload['usr/share/luci/menu.d/luci-qsdk.json']

main, payload, _ = records['luci-qsdk-wn7t94xr']
assert set(payload) == {'etc/config/luci', 'etc/config/ucitrack', 'etc/config/uhttpd',
                        'etc/init.d/luci-ram', 'etc/luci-qsdk/ram-packages', 'sbin/luci-reload',
                        'etc/config/sqm', 'etc/init.d/sqm', 'etc/hotplug.d/iface/11-sqm',
                        'usr/sbin/uhttpd', 'usr/libexec/cgi-io', 'usr/lib/liblucihttp.so', 'usr/lib/liblucihttp.so.0', 'usr/lib/uhttpd_ubus.so'}
assert payload['sbin/luci-reload'] == '/tmp/luci-ram/sbin/luci-reload'
init = payload['etc/init.d/luci-ram'].decode()
subprocess.run(['sh', '-n'], input=init.encode(), check=True)
assert 'START=95' in init and '/root/' not in init
assert 'lowerdir=$ram/$dir:/$dir' in init and 'state=/overlay/luci-ram' in init
assert int(main['Installed-Size']) < 24 * 1024
assert not any(name.startswith(('luci-mod-status', 'luci-mod-system')) for name in records)
manifest = payload['etc/luci-qsdk/ram-packages'].decode()
ram_names = set()
fixtures = {}
for line in manifest.splitlines():
    name, version, sha, url = line.split()
    ram_names.add(name)
    fields, _, path = records[name]
    assert version == fields['Version'] and sha == hashlib.sha256(path.read_bytes()).hexdigest()
    assert url.endswith('/' + path.name)
    assert url.startswith('https://github.com/onokatio/luci/releases/download/v' + main['Version'] + '/') if name in custom_names else url.startswith('https://archive.openwrt.org/releases/packages-19.07/')
    fixtures[url] = str(path.resolve())
assert ram_names == set(records) - persistent and len(ram_names) == len(records) - len(persistent)
libraries = {file: data for name in ram_names for file, data in records[name][1].items()
             if file.startswith('usr/lib/') and '/' not in file.removeprefix('usr/lib/')}
exposed = set(payload) | {'usr/lib/libiwinfo.so'}
for file, data in libraries.items():
    if file in exposed and isinstance(data, str):
        exposed.add(str(pathlib.PurePosixPath(file).parent / data))
assert libraries.keys() <= exposed, f'RAM libraries are not exposed to the system loader: {libraries.keys() - exposed}'
assert {line.split()[0] for line in manifest.splitlines() if 'archive.openwrt.org' in line} == {p['name'] for p in LOCK['base_packages']}
assert records['luci-qsdk-wn7t94xr-runtime'][1].keys() == {'etc/init.d/network', 'sbin/wifi', 'lib/netifd/wireless/qcawificfg80211.sh', 'etc/hotplug.d/iface/11-sqm', 'usr/lib/lua/luci/model/cbi/sqm.lua'}
assert b'/sbin/wifi reload' in records['luci-qsdk-wn7t94xr-runtime'][1]['etc/init.d/network']
assert ('+qsdk' + main['Version']).encode() in records['luci-base'][1]['usr/lib/lua/luci/version.lua']
header = records['luci-base'][1]['usr/lib/lua/luci/view/header.htm']
script_urls = re.findall(rb'src="([^"]+)"', header)
assert len(script_urls) == 2
assert all(url.endswith(('+qsdk' + main['Version']).encode()) for url in script_urls)

prepare_name = 'luci-qsdk-wn7t94xr-prepare'
prepare_path = 'usr/libexec/luci-qsdk-prepare'
prepare_fields, prepare_payload, prepare_ipk = records[prepare_name]
assert set(prepare_payload) == {prepare_path, 'etc/opkg/wn7t94xr-luci.conf', 'etc/opkg/keys/ac707de45b8bb751'}
assert prepare_payload['etc/opkg/keys/ac707de45b8bb751'] == (HERE / 'feed.pub').read_bytes()
assert prepare_payload['etc/opkg/wn7t94xr-luci.conf'] == ('src/gz wn7t94xr_luci https://github.com/onokatio/luci/releases/download/v' + main['Version'] + '\n').encode()
assert prepare_name + ' (= ' + main['Version'] + ')' in main['Depends'].split(', ')
preinst = unpack(unpack(prepare_ipk.read_bytes())['control.tar.gz'])['preinst'].decode()
assert prepare_payload[prepare_path] == preinst.encode()
assert 'opkg install' not in preinst and 'opkg remove' not in preinst
assert '/overlay/luci-base' in preinst and 'usable_login' in preinst
for name in ram_names & custom_names:
    hooks = unpack(unpack(records[name][2].read_bytes())['control.tar.gz'])
    assert prepare_name not in records[name][0]['Depends']
main_hooks = unpack(unpack(records['luci-qsdk-wn7t94xr'][2].read_bytes())['control.tar.gz'])
assert 'exec /' + prepare_path in main_hooks['preinst'].decode()
assert b'luci-ram enable' in main_hooks['postinst'] and b'network restart' not in main_hooks['postinst']
assert 64 <= json.loads((OUT / 'sizes.json').read_text())['preflight_kib'] < 100

with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    status = root / 'stock-status'
    status.write_text('Package: dropbear\nVersion: keep\nStatus: install ok installed\n\nPackage: libiwinfo-lua\nVersion: stock\nStatus: install ok installed\n\n')
    mounts = root / 'mounts'
    mounts.touch()
    mf = root / 'manifest'
    mf.write_text(manifest)
    requests = root / 'requests'
    request_script = root / 'curl.py'
    request_script.write_text('import json,shutil,sys\nm=json.loads(' + repr(json.dumps(fixtures)) + ')\nshutil.copyfile(m[sys.argv[1]],sys.argv[2])\n')
    targets = root / 'root'
    for d in ('usr/lib/lua', 'usr/lib/rpcd', 'usr/libexec/rpcd', 'usr/lib/opkg', 'usr/lib/sqm', 'etc/sqm', 'usr/share', 'www', 'lib/netifd/wireless', 'etc/init.d', 'sbin'):
        (targets / d).mkdir(parents=True, exist_ok=True)
    for f in ('etc/init.d/network', 'sbin/wifi', 'usr/lib/libiwinfo.so'):
        (targets / f).write_text('vendor')
    script = init[init.index('fetch()'):].replace('/proc/mounts', str(mounts))
    script = script.replace('/usr/lib/opkg/status', str(status), 1)
    script = script.replace('"/$dir"', '"' + str(targets) + '/$dir"')
    script = script.replace('"/$file"', '"' + str(targets) + '/$file"')
    script = script.replace(' /$1 overlay ', ' ' + str(targets) + '/$1 overlay ')
    script = script.replace(' /$dir ', ' ' + str(targets) + '/$dir ')
    script = script.replace(' /$file ', ' ' + str(targets) + '/$file ')
    for service in ('network', 'rpcd'):
        for action in ('restart', 'stop', 'start'):
            script = script.replace('/etc/init.d/' + service + ' ' + action, 'service ' + service + ' ' + action)
    script = script.replace('"$ram/etc/init.d/uhttpd" start', 'service uhttpd start')
    script = script.replace('"$ram/etc/init.d/uhttpd" stop', 'service uhttpd stop')
    for action in ('enable', 'disable', 'start', 'stop'):
        script = script.replace('/etc/init.d/sqm ' + action, 'service sqm ' + action)
    stub = f'''
ram='{root}/ram'; state='{root}/state'; manifest='{mf}'; dirs='usr/lib/lua usr/lib/rpcd usr/libexec/rpcd usr/lib/opkg usr/lib/sqm etc/sqm usr/share www lib/netifd/wireless'; bindings='etc/init.d/network sbin/wifi usr/lib/libiwinfo.so'
sha256sum() {{ python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest(), sys.argv[1])' "$1"; }}
logger() {{ :; }}
stat() {{ if [ "$2" = %u:%a ]; then echo 0:755; else echo 0; fi; }}
service() {{ echo "$*" >> '{root}/services'; }}
ubus() {{ :; }}
curl() {{
 for arg; do case "$arg" in https://*) url="$arg";; esac; output="$arg"; done
 echo curl >> '{requests}'
 case "$fail_curl:$url" in 1:*|late:*luci-qsdk-wn7t94xr-runtime*) return 1;; esac
 python3 '{request_script}' "$url" "$output" || return 1
 [ "$bad_sha" != 1 ] || echo bad >> "$output"
}}
mount() {{
 [ "$1" != -o ] || return 0
 if [ "$1" = --bind ]; then
  mv "$3" "$3.vendor"
  ln -s "$2" "$3"
  echo "tmpfs $3 tmpfs rw 0 0" >> '{mounts}'
 else
  [ "$fail_mount" != "$6" ] || return 1
  echo "overlay $6 overlay rw,$5 0 0" >> '{mounts}'
 fi
}}
umount() {{
 if [ "$1" = -l ]; then
  shift
  [ "$allow_lazy" = "$1" ] || return 1
  echo "lazy umount $1" >> '{root}/services'
 else
  [ "$fail_umount" != "$1" ] || return 1
 fi
 if [ -e "$1.vendor" ]; then rm "$1"; mv "$1.vendor" "$1"; fi
 awk -v target="$1" '$2 != target' '{mounts}' > '{mounts}.new'
 mv '{mounts}.new' '{mounts}'
}}
fail_curl=1
if start; then exit 10; fi
[ ! -e "$ram" ] && [ ! -s '{mounts}' ] && [ ! -e "$state" ]
fail_curl=late
if start; then exit 11; fi
[ ! -e "$ram" ] && [ ! -s '{mounts}' ] && [ ! -e "$state" ]
rm -f '{root}/services'
fail_curl=0; bad_sha=1
if start; then exit 12; fi
[ ! -e "$ram" ] && [ ! -e "$state" ]
bad_sha=0; fetch
[ -f "$ram/etc/sqm/sqm.conf" ]
[ "$(grep -c '^Package:' "$ram/usr/lib/opkg/status")" -eq {len(ram_names) + 1} ]
! grep -q '^Version: stock$' "$ram/usr/lib/opkg/status"
grep -q '^Package: dropbear$' "$ram/usr/lib/opkg/status"
[ "$(find "$ram/usr/lib/opkg/info" -name '*.control' | wc -l | tr -d ' ')" -eq {len(ram_names)} ]
! grep -qx /usr/lib/liblucihttp.so.0 "$ram/usr/lib/opkg/info/liblucihttp0.list"
requests="$(wc -l < '{requests}')"
fetch
[ "$(wc -l < '{requests}')" = "$requests" ]
start; start
[ "$(wc -l < '{mounts}' | tr -d ' ')" -eq 12 ]
[ "$(grep -c '^network restart$' '{root}/services')" -eq 1 ]
echo persistent > "$state/upper/www/addon"
fail_umount='{targets}/www'
if stop; then exit 15; fi
[ -e "$ram" ] && [ ! -e "$ram/.started" ]
[ "$(grep -c '^network restart$' '{root}/services')" -eq 1 ]
! grep -q '^network stop$' '{root}/services'
fail_umount=''
start
stop
[ ! -e "$ram" ] && [ ! -s '{mounts}' ]
[ "$(cat '{targets}/sbin/wifi')" = vendor ]
start
[ "$(cat "$state/upper/www/addon")" = persistent ]
fail_umount='{targets}/lib/netifd/wireless'; allow_lazy=''
restarts="$(grep -c '^network restart$' '{root}/services')"
if stop; then exit 16; fi
[ -e "$ram" ] && [ "$(grep -c '^network restart$' '{root}/services')" = "$restarts" ]
! grep -q '^lazy umount' '{root}/services'
allow_lazy="$fail_umount"
stop
grep -qx 'lazy umount {targets}/lib/netifd/wireless' '{root}/services'
[ ! -e "$ram" ] && [ ! -s '{mounts}' ]
fail_umount=''
fail_mount='{targets}/www'
if start; then exit 13; fi
[ ! -s '{mounts}' ] && [ ! -e "$ram" ]
fail_mount=''; fetch
requests="$(wc -l < '{requests}')"
echo corrupt > "$ram/.manifest-sha256"
if start; then exit 14; fi
[ "$(wc -l < '{requests}')" = "$requests" ]
'''
    result = subprocess.run(['bash', '-e'], input=(script + stub).encode(), capture_output=True)
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode() + str(result.returncode)
print(f'{len(custom_names)} custom and {len(official)} official IPKs passed: minimal persistent bootstrap, all {len(ram_names)} runtime packages in RAM, pinned downloads, package records, addon persistence, failure isolation, mount rollback and ARM ABI')
