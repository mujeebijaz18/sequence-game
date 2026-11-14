"""Checks the fun popups (wild / remove / four-in-a-row / hurry) on every player's screen."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e import *

def popup(pg): return pg.evaluate("document.getElementById('popup').className.includes('show') ? document.getElementById('popup').textContent : ''")

srv, port = serve(); url = f'http://127.0.0.1:{port}/index.html'; errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.add_init_script(BROKER_JS)
    host, guest = ctx.new_page(), ctx.new_page()
    for pg in (host, guest): pg.on('pageerror', lambda e: errors.append(str(e))); pg.goto(url)
    host.fill('#name','Ali'); host.click('[data-a=create]'); host.wait_for_selector('.roomcode')
    code = host.inner_text('.roomcode').strip()
    guest.fill('#name','Sara'); guest.fill('#code', code); guest.click('[data-a=join]'); guest.wait_for_selector('.roomcode')
    host.wait_for_function("document.querySelectorAll('.plist li').length===2")
    host.evaluate("window.__seq.S.timer = 13")
    host.click('[data-a=start]'); host.wait_for_selector('.board')
    # 1) hurry popup: appears once the clock is under 10s
    host.wait_for_function("document.getElementById('popup').className.includes('show')", timeout=8000)
    print('hurry ->', popup(host), '|', popup(guest)); assert 'Jaldi karo Bhai' in popup(host)
    host.screenshot(path='/tmp/v8_hurry.png')
    host.evaluate("window.__seq.S.timer = 0; window.__seq.S.deadline = null")
    host.wait_for_timeout(2200)
    # 2) wild jack -> "Han g!"  (host to move)
    host.evaluate("""(() => { const S=window.__seq.S; S.turn=0; S.exchanged=false; S.hands[S.players[0].token][0]='JD'; window.__seq.rebroadcast(); })()""")
    host.click('.hcard[data-i="0"]'); host.click('.cell.hl[data-i="55"]')
    guest.wait_for_function("document.getElementById('popup').className.includes('show')", timeout=4000)
    print('wild ->', popup(host), '|', popup(guest)); assert 'Han g' in popup(guest)
    host.wait_for_timeout(2300)
    # 3) one-eyed jack removes an enemy chip -> "Aao na abb!!"
    guest.evaluate("1")  # keep page alive
    host.evaluate("""(() => { const S=window.__seq; const st=S.S; st.board[60]=1; st.turn=0; st.exchanged=false; st.hands[st.players[0].token][1]='JH'; S.rebroadcast(); })()""")
    host.click('.hcard[data-i="1"]'); host.click('.cell.hl[data-i="60"]')
    guest.wait_for_function("document.getElementById('popup').textContent.includes('Aao')", timeout=4000)
    print('remove ->', popup(guest)); host.wait_for_timeout(2300)
    # 4) four chips of five -> "Bare Taiz ho Rahe Ho"
    host.evaluate("""(() => { const S=window.__seq; const st=S.S; [80,81,82].forEach(i=>{st.board[i]=0}); st.turn=0; st.exchanged=false; st.hands[st.players[0].token][2]='JC'; S.rebroadcast(); })()""")
    host.click('.hcard[data-i="2"]'); host.click('.cell.hl[data-i="83"]')
    guest.wait_for_function("document.getElementById('popup').textContent.includes('Bare Taiz')", timeout=4000)
    print('four ->', popup(guest)); guest.screenshot(path='/tmp/v8_four.png')
    b.close()
srv.shutdown(); print('errors:', errors); sys.exit(1 if errors else 0)
