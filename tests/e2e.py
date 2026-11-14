"""End-to-end smoke test: 3 browser pages play a full game over a fake in-browser PeerJS bus.
   usage: python3 tests/e2e.py   (needs playwright + chrome; serves the repo on localhost)"""
import http.server, threading, socketserver, os, random, sys, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAKE_PEER = r"""
(function(){
  const bc = new BroadcastChannel('fakepeer'); const peers = {}; let n = 0;
  class Conn { constructor(peer, remote, id, initiator){ this.peer=peer; this.peerId=remote; this.id=id; this.open=false; this.h={}; peer._conns[id]=this; }
    on(e,f){ (this.h[e]=this.h[e]||[]).push(f); return this; }
    emit(e,a){ (this.h[e]||[]).forEach(f=>f(a)); }
    send(d){ bc.postMessage({k:'data',to:this.peerId,from:this.peer.id,cid:this.id,d:JSON.parse(JSON.stringify(d))}); }
    close(){ if(!this.open) return; this.open=false; bc.postMessage({k:'close',to:this.peerId,from:this.peer.id,cid:this.id}); this.emit('close'); } }
  window.Peer = class {
    constructor(id,opts){ if(id && typeof id==='object'){ id=null; } this.id = id || ('anon'+(++n)+Math.random().toString(36).slice(2,6)); this.h={}; this._conns={}; this.disconnected=false;
      peers[this.id]=this; setTimeout(()=>this.emit('open',this.id),30);
      this.cb = (ev)=>{ const m=ev.data; if(m.to!==this.id) return;
        if(m.k==='hello'){ const c=new Conn(this,m.from,m.cid); c.open=true; bc.postMessage({k:'accept',to:m.from,from:this.id,cid:m.cid}); this.emit('connection',c); setTimeout(()=>c.emit('open'),0); }
        else if(m.k==='accept'){ const c=this._conns[m.cid]; if(c){ c.open=true; clearTimeout(c.t); c.emit('open'); } }
        else if(m.k==='data'){ const c=this._conns[m.cid]; if(c) c.emit('data',m.d); }
        else if(m.k==='close'){ const c=this._conns[m.cid]; if(c&&c.open){ c.open=false; c.emit('close'); } } };
      bc.addEventListener('message',this.cb); }
    on(e,f){ (this.h[e]=this.h[e]||[]).push(f); return this; }
    emit(e,a){ (this.h[e]||[]).forEach(f=>f(a)); }
    connect(remote){ const cid='c'+Math.random().toString(36).slice(2); const c=new Conn(this,remote,cid); c.t=setTimeout(()=>this.emit('error',{type:'peer-unavailable'}),600); bc.postMessage({k:'hello',to:remote,from:this.id,cid}); return c; }
    reconnect(){} destroy(){ bc.removeEventListener('message',this.cb); Object.values(this._conns).forEach(c=>c.close()); }
  };
})();
"""

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
        ctx.route('**/vendor/peerjs.min.js', lambda r: r.fulfill(body=FAKE_PEER, content_type='application/javascript'))
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
