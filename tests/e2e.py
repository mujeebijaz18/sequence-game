"""End-to-end smoke test: 3 browser pages play a full game over a fake in-browser PeerJS bus.
   usage: python3 tests/e2e.py   (needs playwright + chrome; serves the repo on localhost)"""
import http.server, threading, socketserver, os, random, sys, functools
from playwright.sync_api import sync_playwright

import subprocess, time, atexit
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BROKER_PORT = 18830
_env = dict(os.environ, NODE_PATH=os.environ.get('NODE_PATH', '/home/claude/broker/node_modules'))
_broker = subprocess.Popen(['node', os.path.join(ROOT, 'tests', 'broker.js'), str(BROKER_PORT)], env=_env, stdout=subprocess.PIPE)
_broker.stdout.readline(); atexit.register(_broker.kill)
BROKER_JS = f"window.SEQ_BROKERS=['ws://127.0.0.1:{BROKER_PORT}'];"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self,*a): pass

def serve():
    handler = functools.partial(Quiet, directory=ROOT)
    srv = socketserver.TCPServer(('127.0.0.1', 0), handler); threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]

def main():
    srv, port = serve(); url = f'http://127.0.0.1:{port}/index.html'
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True)
        ctx.add_init_script(BROKER_JS)
        pages = []
        for i in range(3):
            pg = ctx.new_page(); pg.on('pageerror', lambda e, i=i: errors.append((i, str(e)))); pg.on('console', lambda m, i=i: errors.append((i, m.text)) if m.type=='error' else None)
            pg.goto(url); pages.append(pg)
        host, *others = pages
        host.screenshot(path='/tmp/shot_home.png')
        host.fill('#name','Ali'); host.click('[data-a=create]'); host.wait_for_selector('.roomcode')
        code = host.inner_text('.roomcode').strip(); print('room', code)
        for nm, pg in zip(['Sara','Omar'], others):
            pg.fill('#name', nm); pg.fill('#code', code); pg.click('[data-a=join]'); pg.wait_for_selector('.roomcode', timeout=5000)
        host.wait_for_function("document.querySelectorAll('.plist li').length===3")
        host.click('[data-a=teams][data-n="3"]'); host.screenshot(path='/tmp/shot_lobby.png')
        host.click('[data-a=start]')
        for pg in pages: pg.wait_for_selector('.board', timeout=5000)
        print('game started'); [pg.screenshot(path=f'/tmp/s{i}.png') for i,pg in enumerate(pages)]; print([pg.evaluate("document.querySelector('.status .main').className+'|'+document.querySelector('.status .main').innerText") for pg in pages])
        random.seed(5)
        turns = 0
        while turns < int(os.environ.get("MAXT","600")):
            if any(pg.query_selector('.winner') for pg in pages): break
            progressed = False
            for pg in pages:
                st = pg.evaluate("(() => { const m=document.querySelector('.status .main'); return m? m.className : ''; })()")
                if 'mine' not in st: continue
                cards = pg.query_selector_all('.hcard')
                order = list(range(len(cards))); random.shuffle(order)
                done = False
                for i in order:
                    pg.click(f'.hcard[data-i="{i}"]')
                    hl = pg.query_selector_all('.cell.hl')
                    if hl:
                        random.choice(hl).click(); done = True; break
                    if pg.query_selector('[data-a=swap]'):
                        pg.click('[data-a=swap]'); done = True; break
                if not done and pg.query_selector('[data-a=skip]'): pg.click('[data-a=skip]'); done = True
                if done: turns += 1; progressed = True; print('turn', turns, flush=True) if turns % 10 == 0 else None
                if turns == 6: pg.screenshot(path='/tmp/shot_game.png')
            if not progressed: host.wait_for_timeout(50)
        print('turns played', turns)
        winner = host.query_selector('.winner')
        print('winner banner:', winner.inner_text() if winner else None)
        host.screenshot(path='/tmp/shot_over.png')
        b.close()
    srv.shutdown()
    real = [e for e in errors if 'favicon' not in e[1]]
    print('errors:', real)
    sys.exit(1 if real else 0)
if __name__ == "__main__":
    main()
