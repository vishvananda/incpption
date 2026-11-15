#!/usr/bin/env python3
"""Run the published build journey in Apple's Safari through safaridriver."""
import base64
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import time
import urllib.error
import urllib.request

ORIGIN = os.environ.get('SAFARI_TEST_ORIGIN', 'https://incpption.com').rstrip('/')
WORKERS = os.environ.get('SAFARI_TEST_WORKERS', '8')
OUT = Path(os.environ.get('SAFARI_TEST_OUTPUT', 'build/macos-safari'))
OUT.mkdir(parents=True, exist_ok=True)
SESSION = ''
REPORT = {'origin': ORIGIN, 'workers': int(WORKERS), 'system': platform.platform()}

with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    PORT = listener.getsockname()[1]


def command(method, path, data=None):
    request = urllib.request.Request(f'http://127.0.0.1:{PORT}{path}', method=method,
                                    data=None if data is None else json.dumps(data).encode(),
                                    headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=150) as response:
            value = json.load(response)['value']
    except urllib.error.HTTPError as error:
        raise RuntimeError(error.read().decode()) from error
    return value


def js(script, *args):
    return command('POST', f'/session/{SESSION}/execute/sync', {'script': script, 'args': list(args)})


def wait(script, timeout=900):
    deadline, progress = time.monotonic() + timeout, 0
    while time.monotonic() < deadline:
        value = js('return ' + script)
        if value:
            return value
        if time.monotonic() >= progress:
            print(json.dumps(state()), flush=True)
            progress = time.monotonic() + 20
        time.sleep(1)
    raise TimeoutError(script)


def state():
    return js('''return {status:document.getElementById('status')?.textContent,
      cppgm:document.getElementById('completed')?.textContent,
      clang:document.getElementById('completed-clang')?.textContent,
      event:window.lastWorkflowEvent?.kind, error:window.lastWorkflowEvent?.error,
      game:document.getElementById('game-status')?.textContent,
      log:document.getElementById('log')?.textContent, errors:window.safariTestErrors};''')


def check_error():
    result = state()
    if result.get('error') or js('return window.gameError || null'):
        raise RuntimeError(json.dumps(result))


def click(selector):
    element = command('POST', f'/session/{SESSION}/element', {'using': 'css selector', 'value': selector})
    key = 'element-6066-11e4-a52e-4f735466cecf'
    command('POST', f'/session/{SESSION}/element/{element[key]}/click', {})


def screenshot(name):
    data = command('GET', f'/session/{SESSION}/screenshot')
    (OUT / (name + '.png')).write_bytes(base64.b64decode(data))


def play(button):
    click('#' + button)
    wait('window.gamePlaying || window.gameError', 180)
    check_error()
    wait('window.openLaraGame?.drawCalls > 100', 120)
    screenshot(button)
    click('#game-close')
    assert not js('return !!window.gamePlaying'), 'Closing the player kept it running'


def summary(name):
    return js('''const {module,game,player,runtime,...row}=window[arguments[0]]; return row;''', name)


with (OUT / 'safaridriver.log').open('w') as log:
    driver = subprocess.Popen(['/usr/bin/safaridriver', '-p', str(PORT)], stdout=log, stderr=log)
    try:
        for attempt in range(30):
            try:
                command('GET', '/status')
                break
            except (OSError, urllib.error.URLError):
                time.sleep(1)
        session = command('POST', '/session', {'capabilities': {'alwaysMatch': {'browserName': 'safari'}}})
        SESSION = session['sessionId']
        REPORT['capabilities'] = session['capabilities']
        command('POST', f'/session/{SESSION}/timeouts', {'script': 30000, 'pageLoad': 120000, 'implicit': 0})
        command('POST', f'/session/{SESSION}/url', {'url': ORIGIN + '/index.html'})
        wait('!document.getElementById("run-workflow")?.disabled && window.lastProjectEvent?.kind === "source"', 180)
        REPORT['browser'] = js('return {ua:navigator.userAgent,isolated:crossOriginIsolated,cores:navigator.hardwareConcurrency}')
        assert REPORT['browser']['isolated'], 'The page did not enable cross-origin isolation'
        js('''window.safariTestErrors=[];addEventListener('error',e=>safariTestErrors.push(e.message));
          addEventListener('unhandledrejection',e=>safariTestErrors.push(String(e.reason)));
          const target=document.getElementById('build-target');target.value='lara';target.dispatchEvent(new Event('change'));
          document.getElementById('worker-choice').value=arguments[0];''', WORKERS)
        click('[data-phase=game]')
        wait('window.lastWorkflowEvent?.kind === "error" || window.lastGameBuild?.kind === "complete" && window.lastClangGameBuild?.kind === "complete"')
        check_error()
        REPORT['cppgm'] = summary('lastGameBuild')
        REPORT['clang'] = summary('lastClangGameBuild')
        for button in ['game-play', 'game-play-clang']:
            play(button)
        click('[data-journey=inception]')
        click('[data-phase=match]')
        wait('["complete","error"].includes(window.lastInceptionEvent?.kind)')
        check_error()
        REPORT['inception'] = summary('lastInceptionEvent')
        assert REPORT['inception']['kind'] == 'complete', REPORT['inception']
        click('[data-phase=game]')
        wait('window.lastWorkflowEvent?.kind === "error" || window.lastGameBuild?.kind === "complete"')
        check_error()
        REPORT['rebuiltGame'] = summary('lastGameBuild')
        play('game-play')
        assert not js('return window.safariTestErrors'), 'Safari raised a page error'
        REPORT['passed'] = True
        print('PASS: real Safari comparison, both games, strict self-build and rebuilt-compiler game', flush=True)
    except Exception as error:
        REPORT['passed'] = False
        REPORT['error'] = str(error)
        try:
            REPORT['failure'] = state()
            screenshot('failure')
        except Exception as diagnostic:
            REPORT['diagnosticError'] = str(diagnostic)
        raise
    finally:
        (OUT / 'report.json').write_text(json.dumps(REPORT, indent=2) + '\n')
        print(json.dumps({key: value for key, value in REPORT.items() if key != 'inception'}), flush=True)
        if SESSION:
            try:
                command('DELETE', f'/session/{SESSION}')
            except (OSError, RuntimeError):
                pass
        driver.terminate()
        try:
            driver.wait(timeout=10)
        except subprocess.TimeoutExpired:
            driver.kill()
