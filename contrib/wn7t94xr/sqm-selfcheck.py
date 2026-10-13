#!/usr/bin/env python3
"""Check SQM/ECM ownership and failure restoration without touching a router."""
import pathlib
import subprocess
import tempfile

here = pathlib.Path(__file__).resolve().parent
source = (here / 'root/etc/init.d/sqm').read_text()
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    for module in ('sch_cake.ko', 'ifb.ko'):
        (root / module).touch()
    ecm = root / 'ecm-service'
    ecm.write_text('#!/bin/sh\ncase "$1" in stop) [ ! -f "$probe/fail-stop" ] || exit 1; rmdir "$probe/module";; restart) mkdir -p "$probe/module";; *) exit 1;; esac\n')
    ecm.chmod(0o755)
    run = root / 'run.sh'
    run.write_text('#!/bin/sh\ncase "$1" in start) [ ! -f "$probe/fail" ] || exit 1; touch "$probe/queue";; stop) rm -f "$probe/queue";; esac\n')
    run.chmod(0o755)
    script = source.replace('/etc/luci-qsdk/sqm-ecm-enabled', str(root / 'saved'))
    script = script.replace('/etc/init.d/qca-nss-ecm', str(ecm)).replace('/sys/module/ecm', str(root / 'module'))
    script = script.replace('/usr/lib/sqm/run.sh', str(run)).replace('/lib/modules/5.4.213/', str(root) + '/')
    script += r'''
config_load() { :; }
config_foreach() { "$1" queue; }
config_get_bool() { eval "$1=$queue_active"; }
logger() { :; }
uci() {
 case "$*" in
  '-q get ecm.global.enabled') cat "$probe/enabled";;
  '-q set ecm.global.enabled='*) printf '%s\n' "${3#*=}" > "$probe/enabled";;
  '-q commit ecm') :;;
  *) exit 90;;
 esac
}
echo 1 > "$probe/enabled"
mkdir "$probe/module"
queue_active=1
start_service || exit 10
[ "$(cat "$probe/enabled")" = 0 ] && [ -f "$probe/saved" ] && [ ! -d "$probe/module" ] && [ -f "$probe/queue" ] || exit 11
stop_service || exit 12
[ "$(cat "$probe/enabled")" = 0 ] && [ -f "$probe/saved" ] || exit 13
queue_active=0
stop_service || exit 14
[ "$(cat "$probe/enabled")" = 1 ] && [ ! -e "$probe/saved" ] && [ -d "$probe/module" ] || exit 15
queue_active=1
touch "$probe/fail"
! start_service || exit 16
[ "$(cat "$probe/enabled")" = 1 ] && [ ! -e "$probe/saved" ] && [ -d "$probe/module" ] && [ ! -e "$probe/queue" ] || exit 17
rm "$probe/fail"
touch "$probe/fail-stop"
! start_service || exit 21
[ "$(cat "$probe/enabled")" = 1 ] && [ ! -e "$probe/saved" ] && [ -d "$probe/module" ] || exit 22
rm "$probe/fail-stop"
start_service || exit 23
chmod 644 "$probe/run.sh"
! start_service || exit 24
[ "$(cat "$probe/enabled")" = 1 ] && [ ! -e "$probe/saved" ] && [ -d "$probe/module" ] || exit 25
chmod 755 "$probe/run.sh"
rm -f "$probe/queue"
echo 0 > "$probe/enabled"
rmdir "$probe/module"
start_service || exit 18
queue_active=0
stop_service || exit 19
[ "$(cat "$probe/enabled")" = 0 ] && [ ! -e "$probe/saved" ] || exit 20
'''
    subprocess.run(['sh'], input=script, text=True, check=True, timeout=10,
                   env={'PATH': '/usr/bin:/bin', 'probe': str(root)})
print('QSDK SQM selfcheck passed: acceleration ownership, disable and failure restoration')
