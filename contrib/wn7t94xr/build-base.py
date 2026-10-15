#!/usr/bin/env python3
"""Download separate, hash-pinned official dependency IPKs."""
import hashlib
import json
import pathlib
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

HERE = pathlib.Path(__file__).resolve().parent
lock = json.loads((HERE / 'sources.json').read_text())
cache = pathlib.Path(sys.argv[1])
cache.mkdir(parents=True, exist_ok=True)
packages = lock['base_packages']
available = {p['name'] for p in packages} | set(lock['rom_packages']) | set(lock['luci_packages']) | {
    'libc', 'libpthread', 'opkg', 'libiwinfo20181126', 'libiwinfo-lua',
    'rpcd-mod-iwinfo', 'rpcd-mod-luci', 'kmod-sched-cake'}
for package in packages:
    assert all(d.split(' ')[0] in available for d in package['depends'].split(', ') if d)


def download(package):
    path = cache / package['filename']
    if not path.exists():
        url = package.get('url') or ('https://archive.openwrt.org/releases/packages-19.07/'
               'arm_cortex-a7_neon-vfpv4/' + package['feed'] + '/' + package['filename'])
        data = subprocess.check_output(['curl', '-fsSL', '--retry', '2',
                                       '--connect-timeout', '20', '--max-time', '120', url])
        assert hashlib.sha256(data).hexdigest() == package['sha256'], package['name']
        path.write_bytes(data)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == package['sha256'], package['name']


with ThreadPoolExecutor(max_workers=4) as pool:
    list(pool.map(download, packages))
print('Verified', len(packages), 'separate official dependency IPKs in', cache)
