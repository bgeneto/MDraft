"""Launch extracted Debian and AppImage builds in separate disposable profiles.

Build into /tmp/mdraft-dist-final-20261106, stage the packages under
bin/linux/amd64, and extract the DEB to audit-deb with dpkg-deb -x first.
Uses the current X11 display, so run only on a dedicated test desktop.
"""
import json
import os
from pathlib import Path
import subprocess
import time

root = Path('/tmp/mdraft-dist-final-20261106').resolve()
if root != Path('/tmp/mdraft-dist-final-20261106'):
    raise SystemExit('unexpected audit directory')
packages = {
    'deb': root / 'audit-deb/usr/bin/mdraft',
    'appimage': root / 'bin/linux/amd64/mdraft_0.8.0_amd64.AppImage',
}
results = []
for name, binary in packages.items():
    if not binary.is_file():
        raise SystemExit(f'missing {binary}')
    profile = root / f'package-smoke-{name}'
    profile.mkdir(exist_ok=False)
    for part in ('config', 'data', 'cache', 'tmp'):
        (profile / part).mkdir()
    fixture = profile / f'package-{name}.md'
    fixture.write_text('# Package smoke\n\nOriginal text.\n')
    env = os.environ.copy()
    env.update(DISPLAY=':0', GDK_BACKEND='x11', WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS='1',
               WEBKIT_DISABLE_COMPOSITING_MODE='1', APPIMAGE_EXTRACT_AND_RUN='1',
               XDG_CONFIG_HOME=str(profile / 'config'), XDG_DATA_HOME=str(profile / 'data'),
               XDG_CACHE_HOME=str(profile / 'cache'), TMPDIR=str(profile / 'tmp'))
    with (profile / 'application.log').open('wb') as log:
        app = subprocess.Popen([str(binary), str(fixture)], env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 60
            window = None
            while time.monotonic() < deadline and app.poll() is None:
                found = subprocess.run(['xdotool', 'search', '--onlyvisible', '--name', fixture.name],
                                       env=env, capture_output=True, text=True)
                for candidate in found.stdout.splitlines():
                    pid = int(subprocess.check_output(['xdotool', 'getwindowpid', candidate], env=env, text=True))
                    # AppImage's launcher can spawn the actual application.
                    parents = set()
                    while pid > 1 and pid not in parents:
                        parents.add(pid)
                        try:
                            pid = int(Path(f'/proc/{pid}/stat').read_text().split()[3])
                        except (FileNotFoundError, ProcessLookupError):
                            break
                    if app.pid in parents:
                        window = candidate
                        break
                if window:
                    break
                time.sleep(.2)
            if not window:
                raise RuntimeError(f'{name}: owned document window not found')
            subprocess.run(['xdotool', 'windowactivate', '--sync', window], env=env, check=True)
            time.sleep(2)
            subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+Home'], env=env, check=True)
            subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '0', 'PACKAGECHECK'], env=env, check=True)
            time.sleep(1)
            subprocess.run(['xdotool', 'key', '--clearmodifiers', 'ctrl+s'], env=env, check=True)
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not fixture.read_text().startswith('PACKAGECHECK'):
                time.sleep(.2)
            saved = fixture.read_text().startswith('PACKAGECHECK')
            if not saved:
                raise RuntimeError(f'{name}: edited fixture was not saved')
            results.append({'package': name, 'window': True, 'edit_and_save': saved})
        finally:
            app.terminate()
            try:
                app.wait(timeout=10)
            except subprocess.TimeoutExpired:
                app.kill()
                app.wait()
print(json.dumps(results), flush=True)
