"""Forces a near-win position and checks the game-over screen on every device."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import *

srv, port = serve(); url = f'http://127.0.0.1:{port}/index.html'; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.route('**/vendor/peerjs.min.js', lambda r: r.fulfill(body=FAKE_PEER, content_type='application/javascript'))
    pages = []
    for i in range(2):
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e))); pg.goto(url); pages.append(pg)
    host, guest = pages
    host.fill('#name','Ali'); host.click('[data-a=create]'); host.wait_for_selector('.roomcode')
    code = host.inner_text('.roomcode').strip()
    guest.fill('#name','Sara'); guest.fill('#code', code); guest.click('[data-a=join]'); guest.wait_for_selector('.roomcode')
    host.wait_for_function("document.querySelectorAll('.plist li').length===2")
    host.click('[data-a=start]'); host.wait_for_selector('.board')
    # two teams need 2 sequences: pre-build one sequence, then complete a second with a wild jack
    host.evaluate("""(() => { const S=window.__seq.S; const t=S.players[0].token;
      [50,51,52,53,54].forEach(i=>{S.board[i]=0; S.locked[i]=true}); S.seqs.push({team:0,cells:[50,51,52,53,54]});
      [40,41,42,43].forEach(i=>{S.board[i]=0}); S.hands[t][0]='JD'; window.__seq.rebroadcast(); })()""")
    host.click('.hcard[data-i="0"]'); host.click('.cell.hl[data-i="44"]')
    for pg in pages: pg.wait_for_selector('.winner', timeout=4000)
    print('host:', host.inner_text('.winner'), '| guest:', guest.inner_text('.winner'))
    host.screenshot(path='/tmp/shot_over.png'); guest.screenshot(path='/tmp/shot_over_guest.png')
    # play again -> lobby
    host.click('[data-a=again]'); guest.wait_for_selector('.roomcode', timeout=4000); print('back in lobby ok')
    b.close()
srv.shutdown(); print('errors:', errors); sys.exit(1 if errors else 0)
