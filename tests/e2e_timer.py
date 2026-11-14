"""Checks the turn timer auto-plays, and the last-move bar / winner line render."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import *

srv, port = serve(); url = f'http://127.0.0.1:{port}/index.html'; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.route('**/vendor/peerjs.min.js', lambda r: r.fulfill(body=FAKE_PEER, content_type='application/javascript'))
    pages = []
    for i in range(3):
        pg = ctx.new_page(); pg.on('pageerror', lambda e: errors.append(str(e))); pg.goto(url); pages.append(pg)
    host, g1, g2 = pages
    host.fill('#name','Ali'); host.click('[data-a=create]'); host.wait_for_selector('.roomcode')
    code = host.inner_text('.roomcode').strip()
    for nm, pg in (('Sara', g1), ('Omar', g2)):
        pg.fill('#name', nm); pg.fill('#code', code); pg.click('[data-a=join]'); pg.wait_for_selector('.roomcode')
    host.wait_for_function("document.querySelectorAll('.plist li').length===3")
    assert 'on-seg' in host.get_attribute('[data-a=teams][data-n="3"]', 'class'), 'auto 3 teams for 3 players'
    host.evaluate("window.__seq.S.timer = 2")   # 2-second timer for the test
    host.click('[data-a=start]')
    for pg in pages: pg.wait_for_selector('#tbar', timeout=4000)
    host.wait_for_timeout(3800)
    txt = g1.inner_text('.lm'); print('last move bar:', txt.replace('\n',' '))
    assert 'time up' in txt, 'auto move should be flagged'
    turn = g1.inner_text('.pl.turn'); print('turn now:', turn.replace('\n',' '))
    g1.screenshot(path='/tmp/v2_game.png')
    # preview selection while not my turn
    g2.click('.hcard[data-i="0"]'); g2.wait_for_selector('.cell.pv, .cell.hl'); g2.screenshot(path='/tmp/v2_preview.png')
    # winning line
    host.evaluate("window.__seq.S.timer = 0")
    host.evaluate("""(() => { const S=window.__seq.S; [50,51,52,53].forEach(i=>{S.board[i]=0}); S.turn=0; S.hands[S.players[0].token][0]='JD'; S.teams=3; S.need=1; window.__seq.rebroadcast(); })()""")
    host.click('.hcard[data-i="0"]'); host.click('.cell.hl[data-i="54"]')
    for pg in pages: pg.wait_for_selector('.sheetbox', timeout=4000)
    assert host.query_selector('.sl-fg.w'), 'winning line drawn'
    host.screenshot(path='/tmp/v2_win.png')
    host.click('[data-a=closemodal]'); host.screenshot(path='/tmp/v2_win_board.png'); host.wait_for_selector('[data-a=result]')
    b.close()
srv.shutdown(); print('errors:', errors); sys.exit(1 if errors else 0)
