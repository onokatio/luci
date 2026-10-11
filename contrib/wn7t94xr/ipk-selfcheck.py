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
custom_names = {'luci-base', 'luci-mod-network', 'libiwinfo20181126', 'libiwinfo-lua',
                'rpcd-mod-iwinfo', 'rpcd-mod-luci', 'luci-qsdk-wn7t94xr', 'luci-qsdk-wn7t94xr-prepare'}
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
        assert file not in owners, f'Duplicate ownership: {file}'
        owners[file] = name
        assert not file.endswith(('overlay.tar.xz', 'overlay.tar.gz', 'luci-ram'))
        if isinstance(data, bytes) and data.startswith(b'\x7fELF'):
            assert data[:6] == b'\x7fELF\x01\x01' and data[18:20] == b'\x28\x00', file
    for file, data in hooks.items():
        if file in ('preinst', 'postinst', 'prerm', 'postrm'):
            subprocess.run(['sh', '-n'], input=data, check=True)

assert len(records) == 18
assert {name for name, (_, _, path) in records.items() if path.parent == OUT} == custom_names
assert set(re.findall(r'^Package: (.*)$', (OUT / 'Packages').read_text(), re.M)) == custom_names
available = set(records) | set(LOCK['rom_packages']) | {'libc', 'libgcc', 'libpthread', 'opkg', 'netifd', 'ubus', 'jshn'}
for fields, _, _ in records.values():
    for dependency in fields['Depends'].split(', '):
        match = re.fullmatch(r'([a-zA-Z0-9.+-]+)(?: \(= ([^()]+)\))?', dependency)
        assert match and match[1] in available, dependency
        if match[2]:
            assert match[1] in records and records[match[1]][0]['Version'] == match[2], dependency

for original in LOCK['base_packages']:
    name = original['name']
    fields, payload, path = records[name]
    if name not in ('luci-mod-network', 'luci-base'):
        assert hashlib.sha256(path.read_bytes()).hexdigest() == original['sha256'], name
    elif name == 'luci-mod-network':
        assert fields['Version'] == original['version'] + '+qsdk3.1.0'
    if name == 'luci-base':
        assert fields['Version'] == original['version'] + '+ram3.2.1'
        assert set(payload) == {'etc/config/luci', 'etc/config/ucitrack', 'lib/upgrade/keep.d/luci-base',
                                'etc/init.d/luci-base-ram', 'etc/init.d/ucitrack', 'sbin/luci-reload'}
        assert payload['sbin/luci-reload'] == '/tmp/luci-base/sbin/luci-reload'
        init = payload['etc/init.d/luci-base-ram'].decode()
        subprocess.run(['sh', '-n'], input=init.encode(), check=True)
        assert LOCK['ram_base']['url'] in init and LOCK['ram_base']['sha256'] in init
        assert 'upperdir=$state/upper/$dir' in init and 'state=/overlay/luci-base' in init
        assert 'START=95' in init and '/root/' not in init
        assert int(fields['Installed-Size']) < 8192
    if name == 'luci-mod-network':
        assert b'qca_next_ifname' in payload['www/luci-static/resources/view/network/wireless.js']

main, payload, _ = records['luci-qsdk-wn7t94xr']
assert set(payload) == {'usr/share/luci-qsdk/network', 'usr/share/luci-qsdk/wifi', 'lib/netifd/wireless/qcawificfg80211.sh'}
assert 'Provides' not in main
assert 'luci-mod-status' not in available and 'luci-mod-system' not in available and 'luci-compat' not in available
assert owners['usr/lib/rpcd/luci.so'] == 'rpcd-mod-luci'
assert owners['usr/lib/rpcd/iwinfo.so'] == 'rpcd-mod-iwinfo'
assert owners['usr/lib/lua/iwinfo.so'] == 'libiwinfo-lua'
assert owners['etc/init.d/uhttpd'] == 'uhttpd'
assert 'etc/init.d/rpcd' not in owners
prepare_name = 'luci-qsdk-wn7t94xr-prepare'
prepare_path = 'usr/libexec/luci-qsdk-prepare'
prepare_fields, prepare_payload, prepare_ipk = records[prepare_name]
assert set(prepare_payload) == {prepare_path, 'etc/opkg/wn7t94xr-luci.conf', 'etc/opkg/keys/f82c00f7b71cbbcc'}
assert prepare_payload['etc/opkg/keys/f82c00f7b71cbbcc'] == (HERE / 'feed.pub').read_bytes()
assert prepare_payload['etc/opkg/wn7t94xr-luci.conf'] == ('src/gz wn7t94xr_luci https://github.com/onokatio/luci/releases/download/v' + main['Version'] + '\n').encode()
assert prepare_name + ' (= ' + main['Version'] + ')' in main['Depends'].split(', ')
assert prepare_fields['Version'] == main['Version']
preinst = unpack(unpack(prepare_ipk.read_bytes())['control.tar.gz'])['preinst'].decode()
assert prepare_payload[prepare_path] == preinst.encode()
assert 'opkg install' not in preinst and 'restore_cache' not in preinst
for name in ('libiwinfo20181126', 'libiwinfo-lua', 'rpcd-mod-iwinfo', 'rpcd-mod-luci'):
    hooks = unpack(unpack(records[name][2].read_bytes())['control.tar.gz'])
    assert 'preinst' not in hooks, f'Device preparation must not live in {name}'
    assert prepare_name not in records[name][0]['Depends']
main_hooks = unpack(unpack(records['luci-qsdk-wn7t94xr'][2].read_bytes())['control.tar.gz'])
main_preinst = main_hooks['preinst'].decode()
assert 'exec /' + prepare_path in main_preinst
assert 'required=' not in main_preinst and 'usable_login' not in main_preinst
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    helper = root / prepare_path
    control = root / 'usr/lib/opkg/info' / (prepare_name + '.control')
    script = main_preinst.replace('/' + prepare_path, str(helper))
    script = script.replace('/usr/lib/opkg/info/' + prepare_name + '.control', str(control))

    def check_prepare(expected, output=b''):
        result = subprocess.run(['sh'], input=script.encode(), capture_output=True)
        assert result.returncode == expected and result.stdout == output, result.stderr.decode()

    check_prepare(1)
    helper.parent.mkdir(parents=True)
    helper.write_text('#!/bin/sh\nprintf prepared\n')
    helper.chmod(0o755)
    control.parent.mkdir(parents=True)
    control.write_text('Version: outdated\n')
    check_prepare(1)
    control.write_text('Version: ' + main['Version'] + '\n')
    check_prepare(0, b'prepared')
    helper.write_text('#!/bin/sh\nexit 7\n')
    check_prepare(7)
capacity = preinst[preinst.index('\nrequired=') + 1:preinst.index('\numask 077')]
required = int(re.search(r'^required=(\d+)$', capacity, re.M)[1])
assert 300 <= required < 450, 'Count persistent dependencies, metadata and reserve; the base archive only uses RAM'
with tempfile.TemporaryDirectory() as directory:
    info = pathlib.Path(directory)
    capacity = capacity.replace('/usr/lib/opkg/info', directory)
    capacity = capacity.replace('/overlay/upper/', directory + '/upper/')
    capacity = capacity.replace('"/$file"', '"' + directory + '/upper/$file"')
    capacity = capacity.replace('"/rom/$file"', '"' + directory + '/rom/$file"')

    def check_capacity(available, expected):
        stub = f"reclaim=0\ndf() {{ printf '%s\\n' 'Filesystem Blocks Used Available Use% Mounted' 'fake 1144 0 {available} 0% /overlay'; }}\n"
        stub += "sha256sum() { python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],\"rb\").read()).hexdigest())' \"$1\"; }\n"
        result = subprocess.run(['sh'], input=(stub + capacity).encode(), capture_output=True)
        assert (result.returncode == 0) == expected, result.stderr.decode()

    check_capacity(required - 1, False)
    check_capacity(required, True)
    (info / (prepare_name + '.control')).write_text('Version: ' + main['Version'] + '\n')
    prepare_kib = int(re.search(prepare_name + ':' + re.escape(main['Version']) + ':' + re.escape(main['Version']) + r':(\d+)', capacity)[1])
    check_capacity(required - prepare_kib, True)
    (info / (prepare_name + '.control')).unlink()
    for file in ('usr/lib/libiwinfo.so', 'usr/lib/lua/iwinfo.so'):
        for layer in ('upper', 'rom'):
            path = info / layer / file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'vendor' if layer == 'rom' else b'changed')
    check_capacity(required - 16, False)
    for file in ('usr/lib/libiwinfo.so', 'usr/lib/lua/iwinfo.so'):
        (info / 'upper' / file).write_bytes(b'vendor')
    check_capacity(required - 16, True)
    for path in (info / 'upper').rglob('*.so'):
        path.unlink()
    for name, (fields, _, _) in records.items():
        (info / (name + '.control')).write_text('Version: ' + fields['Version'] + '\n')
    credits = re.findall(r'([a-zA-Z0-9.+-]+):([^ :]+):([^ :]+):(\d+)', re.search(r'for credit in (.*); do', capacity)[1])
    credited = max(32, required - sum(int(kib) for _, _, _, kib in credits))
    check_capacity(credited, True)
    for name, _, previous, _ in credits:
        (info / (name + '.control')).write_text('Version: ' + previous + '\n')
    check_capacity(credited, True)
    (info / 'libiwinfo20181126.control').write_text('Version: unknown\n')
    check_capacity(credited, False)
    (info / 'libiwinfo20181126.control').write_text('Version: ' + records['libiwinfo20181126'][0]['Version'] + '\n')
    (info / 'luci-base.control').write_text('Version: outdated\n')
    check_capacity(credited, False)

with tempfile.TemporaryDirectory() as directory:
    config = pathlib.Path(directory) / 'distfeeds.conf'
    detect = preinst[preinst.index('\nstock_feeds=') + 1:preinst.index('\nrequired=')]
    replace = preinst[preinst.index('\nif [ "$stock_feeds" = 1 ]; then') + 1:preinst.index('\nmount -o remount')]
    script = (detect + '\n' + replace).replace('/etc/opkg/distfeeds.conf', str(config))
    for digest, changed in [('unknown', False), ('42630a2cf0641aebf947488d21f57284', True)]:
        config.write_text('original\n')
        stub = f"md5sum() {{ echo '{digest}  file'; }}\n"
        subprocess.run(['sh', '-e'], input=(stub + script).encode(), check=True)
        if changed:
            assert len(config.read_text().splitlines()) == 4
            assert 'packages-19.07/' in config.read_text()
        else:
            assert config.read_text() == 'original\n'
    config.unlink()
    config.symlink_to(pathlib.Path(directory) / 'missing')
    subprocess.run(['sh', '-e'], input=(stub + script).encode(), check=True)
    assert config.is_symlink() and not config.exists()

base = LOCK['ram_base']
base_archive = CACHE / base['filename']
assert base_archive.stat().st_size == base['size']
assert hashlib.sha256(base_archive.read_bytes()).hexdigest() == base['sha256']
core = unpack(unpack(base_archive.read_bytes())['data.tar.gz'])
assert core['www/cgi-bin/luci'].startswith(b'#!/usr/bin/lua\n')
assert b'getHTModes' in core['www/luci-static/resources/network.js']
for _, payload, _ in records.values():
    assert not any(name.endswith(('.tar.xz', '.tar.gz')) for name in payload)
assert not list(OUT.glob('*.tar.*'))

with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    mounts = root / 'mounts'
    mounts.touch()
    script = init.replace('/proc/mounts', str(mounts))
    script = script.replace(' /$1 overlay ', f' {root}/root/$1 overlay ')
    script = script.replace(' /$dir ', f' {root}/root/$dir ')
    script = script.replace('"/$dir"', f'"{root}/root/$dir"')
    script = script.replace('lowerdir=/$dir:', f'lowerdir={root}/root/$dir:')
    script = script.replace('/etc/init.d/rpcd stop', ':').replace('/etc/init.d/uhttpd stop', ':')
    script = script.replace('/etc/init.d/rpcd restart', f"echo restarted >> '{root}/services'")
    script = script.replace('/etc/init.d/uhttpd restart', ':')
    stub = f'''
ram='{root}/ram'; state='{root}/state'
sha256sum() {{ python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest(), sys.argv[1])' "$1"; }}
logger() {{ :; }}
stat() {{ echo 0; }}
curl() {{
 echo curl >> '{root}/requests'
 [ "$fail_curl" != 1 ] || return 1
 for arg; do output="$arg"; done
 cp "$fixture" "$output"
}}
mount() {{
 [ "$1" != -o ] || return 0
 [ "$fail_mount" != "$6" ] || return 1
 echo "overlay $6 overlay rw,$5 0 0" >> '{mounts}'
}}
umount() {{
 awk -v target="$1" '$2 != target' '{mounts}' > '{mounts}.new'
 mv '{mounts}.new' '{mounts}'
}}
fixture='{base_archive}'; fail_curl=1
if start; then exit 10; fi
[ ! -e "$ram" ] && [ ! -s '{mounts}' ] && [ ! -e '{root}/services' ]
fail_curl=0; fixture='{root}/bad'; echo bad > "$fixture"
if fetch; then exit 11; fi
[ ! -e "$ram" ]
fixture='{base_archive}'; fetch
requests="$(wc -l < '{root}/requests')"
fetch
[ "$(wc -l < '{root}/requests')" = "$requests" ]
start; start
[ "$(wc -l < '{mounts}' | tr -d ' ')" = 4 ]
echo persistent > "$state/upper/www/addon"
stop
[ ! -e "$ram" ] && [ ! -s '{mounts}' ]
start
[ "$(cat "$state/upper/www/addon")" = persistent ]
[ "$(wc -l < '{root}/requests')" -eq "$((requests + 1))" ]
stop
fail_mount='{root}/root/usr/share'
if start; then exit 12; fi
[ ! -s '{mounts}' ] && [ ! -e "$ram" ]
fail_mount=''; fixture='{root}/bad'
if start; then exit 13; fi
[ ! -e "$ram" ] && [ ! -s '{mounts}' ]
fixture='{base_archive}'; fetch
requests="$(wc -l < '{root}/requests')"
echo corrupt > "$ram/.archive-sha256"
if start; then exit 14; fi
[ "$(wc -l < '{root}/requests')" = "$requests" ]
'''
    result = subprocess.run(['bash', '-e'], input=(script + stub).encode(), capture_output=True)
    assert result.returncode == 0, result.stdout.decode() + result.stderr.decode()
print('8 custom and 10 official IPKs passed: separate preparation and signed-feed setup, dependency closure, official boot downloads into RAM, persistent addons, failure isolation, capacity checks and ARM ABI')
