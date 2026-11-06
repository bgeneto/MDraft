"""Run only against the instrumented, isolated WSL checkout; never a user profile."""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

root = Path('/tmp/mdraft-group-native-20261106')
variant = sys.argv[1]
run = sys.argv[2]
if variant not in ('baseline', 'grouped', 'production', 'final') or not run.isdecimal():
    raise SystemExit('expected baseline|grouped|production|final and a run number')
profile = root / ('probe-' + variant + '-' + run)
profile.mkdir(exist_ok=False)
for directory in ('config', 'data', 'cache', 'tmp'):
    (profile / directory).mkdir()
fixture = profile / 'large.md'
paragraph = b'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima ' * 2 + b'\r\n\r\n'
fixture.write_bytes(paragraph * 72000)
for marker in ('control-ready.txt', 'layout-metrics.json'):
    (root / marker).unlink(missing_ok=True)
env = os.environ.copy()
env.update(DISPLAY=':0', GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1',
           WEBKIT_DISABLE_COMPOSITING_MODE='1', XDG_CONFIG_HOME=str(profile / 'config'),
           XDG_DATA_HOME=str(profile / 'data'), XDG_CACHE_HOME=str(profile / 'cache'), TMPDIR=str(profile / 'tmp'))
log = (profile / 'application.log').open('wb')
app = subprocess.Popen([str(root / (variant + '-mdraft')), str(fixture)], env=env, stdout=log, stderr=log)
stop_monitor = threading.Event()
memory = {'peak_tree_kib': 0}
def monitor_memory():
    while not stop_monitor.wait(.5):
        rows = subprocess.run(['ps', '-eo', 'pid=,ppid=,rss='], capture_output=True, text=True).stdout.splitlines()
        processes = [tuple(map(int, row.split())) for row in rows if len(row.split()) == 3]
        owned = {app.pid}
        for _ in range(6):
            owned.update(pid for pid, ppid, _ in processes if ppid in owned)
        memory['peak_tree_kib'] = max(memory['peak_tree_kib'], sum(rss for pid, _, rss in processes if pid in owned))
thread = threading.Thread(target=monitor_memory, daemon=True)
thread.start()
try:
    deadline = time.monotonic() + 60
    window = None
    while time.monotonic() < deadline and app.poll() is None:
        result = subprocess.run(['xdotool', 'search', '--onlyvisible', '--pid', str(app.pid)],
                                env=env, capture_output=True, text=True)
        if result.returncode == 0:
            for candidate in result.stdout.splitlines():
                title = subprocess.run(['xdotool', 'getwindowname', candidate], env=env,
                                       capture_output=True, text=True).stdout
                if fixture.name in title:
                    window = candidate
                    break
            if window:
                break
        time.sleep(.1)
    if not window:
        raise RuntimeError('application window not found')
    owner = subprocess.check_output(['xdotool', 'getwindowpid', window], env=env, text=True).strip()
    if int(owner) != app.pid:
        raise RuntimeError('window is not owned by the isolated application')
    subprocess.run(['xdotool', 'windowactivate', '--sync', window], env=env, check=True)
    time.sleep(3)
    subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+Home'], env=env, check=True)
    subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '0', 'linuxlayoutmarker'], env=env, check=True)
    subprocess.run(['xdotool', 'key', '--clearmodifiers', '--repeat', '160', '--delay', '30', 'Right'], env=env, check=True)
    deadline = time.monotonic() + 40
    while not (root / 'control-ready.txt').exists() and time.monotonic() < deadline:
        time.sleep(.02)
    if not (root / 'control-ready.txt').exists():
        raise RuntimeError('positive-control readiness marker missing')
    time.sleep(1.25)
    subprocess.run(['xdotool', 'key', '--clearmodifiers', '--repeat', '20', '--delay', '30', 'Right'], env=env, check=True)
    deadline = time.monotonic() + 40
    while not (root / 'layout-metrics.json').exists() and time.monotonic() < deadline:
        time.sleep(.05)
    result = json.loads((root / 'layout-metrics.json').read_text())
    result['peak_tree_kib'] = memory['peak_tree_kib']
    (profile / 'metrics.json').write_text(json.dumps(result, indent=2))
    editor = [e for e in result['events'] if e['editor']]
    # WebKitGTK's event clock has a stable offset from performance.now().
    # Retain the raw measurements; calibrate by the lowest observed age.
    offset = min((e['age'] for e in editor), default=0)
    natural = sorted(e['age'] - offset for e in editor if e['at'] + offset < result['controlAt'] - 200)
    control = [e['age'] - offset for e in editor if e['at'] + offset >= result['controlAt'] - 200]
    if len(natural) < 20 or not control or max(control) < 150 or not result['marker']:
        raise RuntimeError('invalid samples, positive control, or final preview: ' + json.dumps(dict(count=len(natural), control=control, offset=offset, result=result)))
    def percentile(p):
        return natural[round((len(natural) - 1) * p)]
    print(json.dumps(dict(variant=variant, run=run, count=len(natural), p50=percentile(.5),
                          p95=percentile(.95), p99=percentile(.99), maximum=max(natural),
                          positive_control=max(control), clock_offset=offset, groups=result['groups'], marker=result['marker'], **memory)), flush=True)
finally:
    stop_monitor.set()
    thread.join(timeout=3)
    app.terminate()
    try:
        app.wait(timeout=10)
    except subprocess.TimeoutExpired:
        app.kill()
        app.wait()
    log.close()
