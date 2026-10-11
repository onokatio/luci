#!/usr/bin/env python3
"""Check package paths, directories, payload and lifecycle hook syntax."""
import io
import pathlib
import subprocess
import sys
import tarfile

with tarfile.open(sys.argv[1]) as ipk:
    assert set(ipk.getnames()) == {'debian-binary', 'control.tar.gz', 'data.tar.gz'}
    with tarfile.open(fileobj=io.BytesIO(ipk.extractfile('data.tar.gz').read())) as data:
        names = set(data.getnames())
        files = {entry.name for entry in data if entry.isfile()}
        assert files == {'usr/share/luci-qsdk/overlay.tar.xz', 'etc/init.d/luci-ram',
                         'lib/netifd/wireless/qcawificfg80211.sh'}
        for name in files:
            path = pathlib.PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts
            assert all(str(parent) in names and data.getmember(str(parent)).isdir()
                       for parent in path.parents if str(parent) != '.')
        with tarfile.open(fileobj=io.BytesIO(data.extractfile('usr/share/luci-qsdk/overlay.tar.xz').read())) as overlay:
            for entry in overlay:
                assert not entry.name.startswith('/') and '..' not in pathlib.PurePosixPath(entry.name).parts
            assert overlay.getmember('usr/lib/rpcd/iwinfo.so').isfile()
            assert overlay.getmember('usr/lib/rpcd/luci.so').isfile()
    with tarfile.open(fileobj=io.BytesIO(ipk.extractfile('control.tar.gz').read())) as control:
        for name in ['preinst', 'postinst', 'prerm', 'postrm']:
            subprocess.run(['sh', '-n'], input=control.extractfile(name).read(), check=True)
print('IPK selfcheck passed: payload, parent directories and four lifecycle hooks')
