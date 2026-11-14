/* Sequence Online – UI + peer-to-peer networking (PeerJS / WebRTC).
   One player is the HOST and holds the authoritative game state; everyone else connects to the host by room code. */
(function () {
  'use strict';
  const G = window.SeqGame;
  const $app = document.getElementById('app');
  const $toast = document.getElementById('toast');
  const $modal = document.getElementById('modal');

  const PEER_PREFIX = 'seqgame-';
  const PEER_OPTS = {
    debug: 1,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'],
          username: 'openrelayproject', credential: 'openrelayproject' },
      ],
    },
  };
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  // ---------- tiny helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const rnd = (n) => Array.from({ length: n }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };
  function sessionToken() {
    let t = null;
    try { t = sessionStorage.getItem('seq_token'); } catch (e) { /* ignore */ }
    if (!t) { t = rnd(16) + Date.now().toString(36); try { sessionStorage.setItem('seq_token', t); } catch (e) { /* ignore */ } }
    return t;
  }
  const setSessionToken = (t) => { try { sessionStorage.setItem('seq_token', t); } catch (e) { /* ignore */ } };
  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg; $toast.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $toast.classList.remove('show'), 2400);
  }

  // ---------- app state ----------
  let mode = null;          // 'host' | 'client' | null
  let peer = null;
  let myToken = sessionToken();
  let myName = store.get('seq_name') || '';
  let room = null;
  let S = null;             // host only: authoritative state
  let conns = {};           // host only: token -> DataConnection
  let connected = {};       // host only: token -> bool
  let hostConn = null;      // client only
  let V = null;             // current view of the game
  let selected = null;      // selected hand index
  let gotState = false;
  let reconnectTimer = null;
  let leaving = false;
  let prevTurnMine = false;
  let banner = '';

  // ---------- HOME ----------
  function renderHome(msg) {
    mode = null; V = null; S = null;
    const hostSave = store.get('seq_host');
    const clientSave = store.get('seq_client');
    const hashCode = (location.hash || '').replace('#', '').toUpperCase().slice(0, 5);
    $app.innerHTML = `
      <div class="screen">
        <h1>🂡 Sequence</h1>
        <p class="sub">Play online with friends — no sign-up</p>
        <div><label for="name">Your name</label>
          <input type="text" id="name" maxlength="14" placeholder="e.g. Ali" value="${esc(myName)}" autocomplete="nickname"></div>
        <button class="btn primary" data-a="create">Create a game</button>
        <div class="or">— or join a friend's game —</div>
        <input type="text" id="code" maxlength="5" placeholder="CODE" value="${esc(hashCode)}" autocapitalize="characters" autocomplete="off" spellcheck="false">
        <button class="btn" data-a="join">Join game</button>
        <div class="err" id="err">${esc(msg || '')}</div>
        ${hostSave ? `<button class="btn" data-a="resume-host">▶ Resume your hosted game (${esc(hostSave.room)})</button>` : ''}
        ${clientSave ? `<button class="btn" data-a="rejoin">↩ Rejoin game ${esc(clientSave.room)}</button>` : ''}
        <button class="link" data-a="rules">How to play</button>
      </div>`;
  }
  function readName() {
    const el = document.getElementById('name');
    const n = (el ? el.value : myName).trim().slice(0, 14);
    if (!n) { setErr('Please enter your name first.'); if (el) el.focus(); return null; }
    myName = n; store.set('seq_name', n);
    return n;
  }
  function setErr(m) { const e = document.getElementById('err'); if (e) e.textContent = m; else toast(m); }

  // ---------- NETWORK: HOST ----------
  function newPeer(id) {
    if (peer) { try { peer.destroy(); } catch (e) { /* ignore */ } }
    peer = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    return peer;
  }

  function startHosting(resumeSave) {
    const name = resumeSave ? null : readName();
    if (!resumeSave && !name) return;
    mode = 'host';
    leaving = false;
    banner = '';
    if (resumeSave) {
      room = resumeSave.room; S = resumeSave.state; myToken = resumeSave.token; setSessionToken(myToken);
    } else {
      room = rnd(5); S = G.newLobby(room, myToken, name);
    }
    connected = { [myToken]: true }; conns = {};
    $app.innerHTML = '<div class="screen"><h1>Opening room…</h1></div>';
    openHostPeer(!resumeSave, 0);
  }

  let openTimer, lastPeerErr = '';
  function netFail(extra) {
    $app.innerHTML = `<div class="screen"><h1>Can't connect</h1>
      <p class="sub">The game couldn't reach the matchmaking server (peerjs.com).</p>
      <div class="card-box note">Error: ${esc(lastPeerErr || 'timed out')}${extra ? '<br>' + esc(extra) : ''}<br><br>
      Try: turn off ad-blocker / privacy extensions for this site, disconnect VPN, try an Incognito window, or switch between Wi-Fi and mobile data.</div>
      <button class="btn primary" data-a="retry">Try again</button>
      <button class="link" data-a="cancel">Back</button></div>`;
  }
  function openHostPeer(canRetryCode, attempt) {
    const p = newPeer(PEER_PREFIX + room);
    clearTimeout(openTimer); lastPeerErr = '';
    openTimer = setTimeout(() => { if (!p.open && !leaving) netFail(); }, 12000);
    p.on('open', () => { clearTimeout(openTimer); S.room = room; saveHost(); refreshView(); });
    p.on('connection', onHostConnection);
    p.on('disconnected', () => { if (!leaving && peer === p) setTimeout(() => { try { p.reconnect(); } catch (e) { /* ignore */ } }, 1500); });
    p.on('error', (e) => {
      lastPeerErr = (e.type || '') + ' ' + (e.message || '');
      if (!p.open && e.type !== 'unavailable-id') { clearTimeout(openTimer); netFail(); return; }
      if (e.type === 'unavailable-id') {
        if (canRetryCode && attempt < 5) { room = rnd(5); S.room = room; openHostPeer(true, attempt + 1); }
        else { toast('That room is still open somewhere else. Close the other tab and try again.'); renderHome('Room code is in use — close other tabs of this game, then try again.'); }
      } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error' || e.type === 'socket-closed') {
        banner = 'Connection to the matchmaking server lost — retrying…'; if (V) render();
      } else { console.warn('peer error', e); }
    });
  }

  function onHostConnection(conn) {
    conn.on('data', (m) => hostHandle(conn, m));
    conn.on('close', () => {
      for (const t in conns) if (conns[t] === conn) { delete conns[t]; connected[t] = false; }
      refreshView(true);
    });
    conn.on('error', () => {});
  }

  function hostHandle(conn, m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'join') {
      const token = String(m.token || '');
      let p = S.players.find((x) => x.token === token);
      if (!p) {
        if (S.phase !== 'lobby') return conn.send({ t: 'fatal', msg: 'That game has already started.' });
        if (S.players.length >= 12) return conn.send({ t: 'fatal', msg: 'That room is full.' });
        S.players.push({ token, name: String(m.name || 'Player').slice(0, 14) });
        p = S.players[S.players.length - 1];
      }
      if (conns[token] && conns[token] !== conn) { try { conns[token].close(); } catch (e) { /* ignore */ } }
      conns[token] = conn; connected[token] = true;
      refreshView(true);
      return;
    }
    const token = Object.keys(conns).find((t) => conns[t] === conn);
    if (!token) return;
    const res = hostAction(token, m);
    if (res && !res.ok && res.error) conn.send({ t: 'toast', msg: res.error });
  }

  // all state changes (host's own and remote players') go through here
  function hostAction(token, m) {
    const seat = G.seatOf(S, token);
    if (seat < 0) return { ok: false, error: 'Unknown player' };
    const isHost = seat === 0;
    let res = { ok: true };
    switch (m.t) {
      case 'play': res = G.applyPlay(S, token, m.idx | 0, m.cell | 0); break;
      case 'dead': res = G.applyDead(S, token, m.idx | 0); break;
      case 'skip': res = G.applySkip(S, token); break;
      case 'teams':
        if (!isHost || S.phase !== 'lobby') return { ok: false, error: 'Only the host can do that' };
        S.teams = m.n === 3 ? 3 : 2; break;
      case 'start':
        if (!isHost || S.phase !== 'lobby') return { ok: false, error: 'Only the host can start' };
        res = G.startGame(S); break;
      case 'again':
        if (!isHost) return { ok: false, error: 'Only the host can do that' };
        S.phase = 'lobby'; S.hands = {}; S.deck = []; S.discard = []; S.seqs = []; S.last = null; S.winner = null; S.log = [];
        S.board = Array(100).fill(null); S.locked = Array(100).fill(false); break;
      case 'kick':
        if (!isHost || S.phase !== 'lobby') return { ok: false, error: 'Only the host can do that' };
        if (m.seat > 0 && m.seat < S.players.length) {
          const t = S.players[m.seat].token;
          if (conns[t]) { try { conns[t].send({ t: 'fatal', msg: 'The host removed you from the room.' }); } catch (e) { /* ignore */ } setTimeout(() => { try { conns[t] && conns[t].close(); } catch (e) { /* ignore */ } }, 300); }
          S.players.splice(m.seat, 1); delete conns[t]; delete connected[t];
        }
        break;
      case 'leave':
        if (S.phase === 'lobby' && !isHost) { S.players.splice(seat, 1); delete conns[token]; delete connected[token]; }
        break;
      default: return { ok: false, error: 'Unknown action' };
    }
    if (res.ok) { saveHost(); broadcast(); }
    return res;
  }

  function refreshView(save) { if (save) saveHost(); broadcast(); }
  function broadcast() {
    for (const p of S.players) {
      const c = conns[p.token];
      if (c && c.open) { try { c.send({ t: 'state', v: G.view(S, p.token, connected) }); } catch (e) { /* ignore */ } }
    }
    onView(G.view(S, myToken, connected));
  }
  function saveHost() { if (S) store.set('seq_host', { room, token: myToken, state: S }); }

  // ---------- NETWORK: CLIENT ----------
  function startJoining(codeRaw, saved) {
    const name = saved ? saved.name : readName();
    if (!name) return;
    const code = (codeRaw || '').trim().toUpperCase();
    if (code.length !== 5) return setErr('Enter the 5-letter room code.');
    mode = 'client'; room = code; leaving = false; gotState = false; banner = '';
    if (saved) { myToken = saved.token; setSessionToken(myToken); } else myToken = sessionToken();
    myName = name;
    $app.innerHTML = `<div class="screen"><h1>Joining ${esc(room)}…</h1><p class="sub">Connecting to your friend</p><button class="link" data-a="cancel">Cancel</button></div>`;
    clientConnect();
  }

  let connectTimeout;
  function clientConnect() {
    clearTimeout(reconnectTimer); clearTimeout(connectTimeout);
    if (leaving) return;
    const p = newPeer();
    hostConn = null;
    p.on('open', () => {
      const c = p.connect(PEER_PREFIX + room, { reliable: true, serialization: 'json' });
      hostConn = c;
      c.on('open', () => { clearTimeout(connectTimeout); c.send({ t: 'join', token: myToken, name: myName }); });
      c.on('data', clientHandle);
      c.on('close', () => { if (hostConn === c) scheduleReconnect(); });
      c.on('error', () => {});
    });
    p.on('disconnected', () => { try { p.reconnect(); } catch (e) { /* ignore */ } });
    p.on('error', (e) => {
      if (e.type === 'peer-unavailable') { onUnreachable(); }
      else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') scheduleReconnect();
    });
    connectTimeout = setTimeout(() => { if (!gotState) onUnreachable(); }, 12000);
  }
  function onUnreachable() {
    if (leaving) return;
    if (!gotState) {
      clearTimeout(reconnectTimer);
      leaving = true; cleanupNet();
      renderHome(`Couldn't find room ${room}. Check the code, and make sure the host keeps their page open.`);
    } else scheduleReconnect();
  }
  function scheduleReconnect() {
    if (leaving) return;
    banner = 'Connection lost — reconnecting…'; if (V) render();
    clearTimeout(reconnectTimer); reconnectTimer = setTimeout(clientConnect, 2500);
  }
  function clientHandle(m) {
    if (!m) return;
    if (m.t === 'state') { gotState = true; banner = ''; store.set('seq_client', { room, token: myToken, name: myName }); onView(m.v); }
    else if (m.t === 'toast') toast(m.msg);
    else if (m.t === 'fatal') { leaving = true; cleanupNet(); store.del('seq_client'); renderHome(m.msg); }
  }

  function act(a) {
    if (mode === 'host') { const r = hostAction(myToken, a); if (r && !r.ok && r.error) toast(r.error); }
    else if (hostConn && hostConn.open) hostConn.send(a);
    else toast('Not connected right now…');
  }

  function cleanupNet() {
    clearTimeout(reconnectTimer); clearTimeout(connectTimeout);
    try { peer && peer.destroy(); } catch (e) { /* ignore */ }
    peer = null; hostConn = null; conns = {}; connected = {}; V = null; selected = null; banner = '';
    closeModal();
    document.title = 'Sequence Online';
  }
  function leaveRoom() {
    if (mode === 'client' && hostConn && hostConn.open) { try { hostConn.send({ t: 'leave' }); } catch (e) { /* ignore */ } }
    leaving = true;
    if (mode === 'client') store.del('seq_client');
    if (mode === 'host') store.del('seq_host');
    cleanupNet(); S = null; mode = null;
    history.replaceState(null, '', location.pathname);
    renderHome();
  }

  // ---------- view handling ----------
  function onView(v) {
    const mineNow = v.phase === 'playing' && v.turn === v.you;
    if (mineNow && !prevTurnMine) { try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (e) { /* ignore */ } }
    prevTurnMine = mineNow;
    if (!mineNow) selected = null;
    if (V && V.hand.length !== v.hand.length) selected = null;
    V = v;
    document.title = mineNow ? '● Your turn — Sequence' : 'Sequence Online';
    render();
  }
  function render() {
    if (!V) return;
    if (V.phase === 'lobby') renderLobby(); else renderGame();
    if (V.phase === 'over') showOver(); else if ($modal.dataset.kind === 'over') closeModal();
  }

  // ---------- LOBBY ----------
  function renderLobby() {
    const v = V, n = v.players.length;
    const link = `${location.origin}${location.pathname}#${v.room}`;
    const okTeams = n >= 2 && n % v.teams === 0;
    let hint = '';
    if (n < 2) hint = 'Waiting for at least one more player…';
    else if (!okTeams) hint = `${n} players can't split into ${v.teams} equal teams — ${v.teams === 2 ? 'try 3 teams or ' : ''}wait for ${v.teams === 2 ? 'an even number' : 'a multiple of 3'}.`;
    else hint = `${n} players · ${v.teams} teams of ${n / v.teams} · first to ${v.teams === 2 ? '2 sequences' : '1 sequence'} wins`;
    $app.innerHTML = `
      ${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
      <div class="screen">
        <div class="note" style="text-align:center">Room code — share it with your friends</div>
        <div class="roomcode">${esc(v.room)}</div>
        <div class="row">
          <button class="btn small" data-a="share">📤 Share invite link</button>
          <button class="btn small" data-a="copycode">Copy code</button>
        </div>
        <div class="card-box">
          <label>Players (${n}/12)</label>
          <ul class="plist" style="margin-top:8px">
            ${v.players.map((p, i) => `
              <li class="t${p.team}"><span class="dot"></span><span class="nm">${esc(p.name)}${i === v.you ? ' (you)' : ''}</span>
                ${i === 0 ? '<span class="tag-host">HOST</span>' : ''}
                <span class="${p.connected || i === 0 ? 'on' : 'off'}"></span>
                ${v.isHost && i > 0 ? `<button class="x" data-a="kick" data-i="${i}" aria-label="Remove">✕</button>` : ''}
              </li>`).join('')}
          </ul>
        </div>
        ${v.isHost ? `
          <div class="card-box"><label>Teams</label>
            <div class="seg" style="margin-top:6px">
              <button data-a="teams" data-n="2" class="${v.teams === 2 ? 'on-seg' : ''}">2 teams</button>
              <button data-a="teams" data-n="3" class="${v.teams === 3 ? 'on-seg' : ''}">3 teams</button>
            </div>
            <div class="note" style="margin-top:8px">Players take turns in join order and are split into teams alternately (Blue, Green, Red…).</div>
          </div>
          <div class="note" style="text-align:center">${esc(hint)}</div>
          <button class="btn primary" data-a="start" ${n >= 2 && okTeams ? '' : 'disabled'}>Start game</button>`
        : `<div class="note" style="text-align:center">${esc(hint)}<br>Waiting for the host to start…</div>`}
        <button class="link" data-a="leave">Leave room</button>
      </div>`;
  }

  // ---------- GAME ----------
  function renderGame() {
    const v = V, me = v.you, myTurn = v.phase === 'playing' && v.turn === me;
    const myTeam = me % v.teams;
    const hand = v.hand;
    const selCard = selected !== null ? hand[selected] : null;
    const hl = new Set(selCard ? G.legalCells(v, selCard, myTeam) : []);
    const dead = hand.map((c) => G.isDead(v, c));
    const anyMove = G.hasAnyMove(v, hand, myTeam);
    const canSwap = myTurn && !v.exchanged && dead.some(Boolean);
    const canPass = myTurn && !anyMove && (v.exchanged || !dead.some(Boolean));
    const cur = v.players[v.turn];

    let cells = '';
    for (let i = 0; i < 100; i++) {
      const c = G.BOARD[i];
      const cls = ['cell'];
      let inner;
      if (c === 'F') { cls.push('free'); inner = '★'; }
      else {
        const s = G.suitOf(c); if (s === 'H' || s === 'D') cls.push('red');
        inner = `<span>${G.rankOf(c)}</span><span class="su">${G.GLYPH[s]}</span>`;
      }
      const t = v.board[i];
      if (t !== null) { cls.push('occ'); if (v.locked[i]) cls.push('locked'); inner += `<span class="chip t${t}">${['●', '◆', '▲'][t]}</span>`; }
      if (hl.has(i)) cls.push('hl');
      if (v.last && v.last.cell === i) { cls.push('last'); if (v.last.type === 'remove') cls.push('lastrm'); }
      cells += `<button class="${cls.join(' ')}" data-a="cell" data-i="${i}" aria-label="${c}">${inner}</button>`;
    }

    let main, mainCls = '';
    if (v.phase === 'over') main = 'Game over';
    else if (myTurn) {
      mainCls = 'mine';
      if (!selCard) main = canPass ? 'No moves available — pass your turn' : '🎯 Your turn — pick a card';
      else if (G.jackKind(selCard) === 'remove') main = hl.size ? 'Tap an enemy chip to remove it' : 'No chips to remove with this jack';
      else if (G.jackKind(selCard) === 'wild') main = 'Wild! Tap any empty spot';
      else if (dead[selected]) main = v.exchanged ? 'Dead card — already swapped this turn' : 'Dead card: both spots taken. Swap it!';
      else main = 'Tap a highlighted spot';
    } else main = `Waiting for ${esc(cur.name)}…`;

    $app.innerHTML = `
      ${banner ? `<div class="banner">${esc(banner)}</div>` : ''}
      <div class="game">
        <div class="topbar">
          <div class="score">${v.seqCount.map((n, t) => `<div class="sc ${cur && cur.team === t && v.phase === 'playing' ? 'cur' : ''}"><span class="dot t${t}"></span>${G.TEAM_NAMES[t]} ${n}/${v.need}</div>`).join('')}</div>
          <button class="iconbtn" data-a="rules" aria-label="Rules">?</button>
          <button class="iconbtn" data-a="menu" aria-label="Menu">☰</button>
        </div>
        <div class="players">${v.players.map((p) => `<div class="pl t${p.team} ${p.seat === v.turn && v.phase === 'playing' ? 'turn' : ''} ${p.seat === me ? 'me' : ''}"><span class="dot"></span><b>${esc(p.name)}</b><span class="cnt">${p.cards}🂠</span><span class="${p.connected ? 'on' : 'off'}"></span></div>`).join('')}</div>
        <div class="board ${selCard ? 'sel' : ''}">${cells}</div>
        <div class="status"><div class="main ${mainCls}">${main}</div><div class="lg">${esc(v.log[v.log.length - 1] || '')}</div></div>
        <div class="actions">
          ${myTurn && selCard && dead[selected] && canSwap ? '<button class="btn primary" data-a="swap">♻ Swap dead card</button>' : ''}
          ${canPass ? '<button class="btn" data-a="skip">Pass turn</button>' : ''}
          ${myTurn && !selCard && canSwap ? '<button class="btn" data-a="swapany">♻ Swap dead card</button>' : ''}
        </div>
        <div class="hand">${hand.map((c, i) => {
          const s = G.suitOf(c), jk = G.jackKind(c);
          const cls = ['hcard']; if (s === 'H' || s === 'D') cls.push('red'); if (i === selected) cls.push('sel'); if (dead[i]) cls.push('dead'); if (jk) cls.push('jack'); if (!myTurn) cls.push('dim');
          return `<button class="${cls.join(' ')}" style="--n:${Math.max(hand.length, 5)}" data-a="pick" data-i="${i}"><span>${G.rankOf(c)}</span><span class="su">${G.GLYPH[s]}</span>${jk ? `<i class="tg">${jk === 'wild' ? 'WILD' : 'REMOVE'}</i>` : dead[i] ? '<i class="tg">DEAD</i>' : ''}</button>`;
        }).join('')}</div>
      </div>`;
  }

  function showOver() {
    if ($modal.dataset.kind === 'over') return;
    const v = V, w = v.winner;
    const mine = w === v.you % v.teams;
    const ws = v.players.filter((p) => p.team === w).map((p) => esc(p.name)).join(' & ');
    openModal(`<div class="mbox"><div class="big-emoji">${mine ? '🏆' : '🎉'}</div>
      <div class="winner" style="color:var(--t${w})">${G.TEAM_NAMES[w]} team wins!</div>
      <div class="note" style="text-align:center">${ws}</div>
      ${v.isHost ? '<button class="btn primary" data-a="again">Play again (back to lobby)</button>' : '<div class="note" style="text-align:center">Waiting for the host to start a new game…</div>'}
      <button class="btn" data-a="closemodal">Look at the board</button>
      <button class="link" data-a="leave">Leave room</button></div>`, 'over');
  }

  const RULES = `<div class="mbox"><h2>How to play</h2><ul>
    <li><b>Goal:</b> make <b>5 chips in a row</b> (across, down or diagonal) — that's a <i>sequence</i>. With <b>2 teams</b> you need <b>2 sequences</b>; with <b>3 teams</b>, just <b>1</b>.</li>
    <li><b>Your turn:</b> pick a card, tap a highlighted matching spot on the board to place your team's chip, then you draw a new card.</li>
    <li>The four <b>gold ★ corners</b> count as your chip for everyone.</li>
    <li><b>Two-eyed jacks</b> (♦ ♣) are <b>wild</b> — place a chip on any empty spot.</li>
    <li><b>One-eyed jacks</b> (♥ ♠) <b>remove</b> an enemy chip (not one that's already part of a sequence).</li>
    <li><b>Dead card:</b> if both spots for a card are covered, swap it for a new card — once per turn, then still play.</li>
    <li>Chips in a finished sequence are locked (gold glow). Two sequences may share one chip.</li>
    <li>Teams alternate: in 4 or 6 player games you sit alternately with teammates.</li></ul>
    <button class="btn primary" data-a="closemodal">Got it</button></div>`;

  function openModal(html, kind) { $modal.innerHTML = html; $modal.dataset.kind = kind || ''; $modal.hidden = false; }
  function closeModal() { $modal.hidden = true; $modal.innerHTML = ''; $modal.dataset.kind = ''; }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el) return;
    const a = el.dataset.a, i = el.dataset.i !== undefined ? +el.dataset.i : null;
    switch (a) {
      case 'create': startHosting(); break;
      case 'join': startJoining(document.getElementById('code').value); break;
      case 'resume-host': { const s = store.get('seq_host'); if (s) { myName = (s.state.players[0] || {}).name || myName; startHosting(s); } break; }
      case 'rejoin': { const s = store.get('seq_client'); if (s) startJoining(s.room, s); break; }
      case 'cancel': leaving = true; clearTimeout(openTimer); cleanupNet(); renderHome(); break;
      case 'retry': if (mode === 'host' && S) { $app.innerHTML = '<div class="screen"><h1>Opening room…</h1></div>'; openHostPeer(S.phase === 'lobby', 0); } else renderHome(); break;
      case 'rules': openModal(RULES, 'rules'); break;
      case 'closemodal': closeModal(); break;
      case 'menu': openModal(`<div class="mbox"><h2>Menu</h2><div class="note">Room <b>${esc(V.room)}</b></div>
        <button class="btn" data-a="share">📤 Share invite link</button>
        <button class="btn" data-a="closemodal">Back to game</button>
        <button class="btn" data-a="leave">Leave game</button></div>`, 'menu'); break;
      case 'share': shareInvite(); break;
      case 'copycode': copyText(V.room, 'Code copied'); break;
      case 'leave': if (!V || V.phase === 'lobby' || V.phase === 'over' || confirm('Leave the game? Others will keep playing' + (mode === 'host' ? ' only if you stay — the host closing ends the room.' : '.'))) leaveRoom(); break;
      case 'teams': act({ t: 'teams', n: +el.dataset.n }); break;
      case 'kick': act({ t: 'kick', seat: i }); break;
      case 'start': act({ t: 'start' }); break;
      case 'again': closeModal(); act({ t: 'again' }); break;
      case 'pick': {
        if (!V || V.phase !== 'playing') break;
        if (V.turn !== V.you) { toast("It's not your turn yet"); break; }
        selected = selected === i ? null : i; render(); break;
      }
      case 'cell': {
        if (selected === null || !V || V.turn !== V.you) break;
        const card = V.hand[selected];
        if (!card) break;
        if (G.legalCells(V, card, V.you % V.teams).includes(i)) { const idx = selected; selected = null; act({ t: 'play', idx, cell: i }); }
        break;
      }
      case 'swap': if (selected !== null) { const idx = selected; selected = null; act({ t: 'dead', idx }); } break;
      case 'swapany': { const idx = V.hand.findIndex((c) => G.isDead(V, c)); if (idx >= 0) act({ t: 'dead', idx }); break; }
      case 'skip': act({ t: 'skip' }); break;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'code') startJoining(document.activeElement.value);
    if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'name') startHosting();
  });

  function inviteLink() { return `${location.origin}${location.pathname}#${V.room}`; }
  function shareInvite() {
    const url = inviteLink(), text = `Join my Sequence game! Room code: ${V.room}`;
    if (navigator.share) navigator.share({ title: 'Sequence', text, url }).catch(() => {});
    else copyText(`${text}\n${url}`, 'Invite copied');
  }
  function copyText(t, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast(okMsg), () => toast(t));
    else { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast(t); } ta.remove(); }
  }

  // Come back from a sleeping phone: reconnect quickly.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || leaving) return;
    if (mode === 'client' && gotState && !(hostConn && hostConn.open)) { clearTimeout(reconnectTimer); clientConnect(); }
    if (mode === 'host' && peer && peer.disconnected) { try { peer.reconnect(); } catch (e) { /* ignore */ } }
  });
  window.addEventListener('beforeunload', () => { if (mode === 'host') saveHost(); });

  renderHome();
  // expose a few things for debugging in the console
  window.__seq = { get S() { return S; }, get V() { return V; }, rebroadcast: () => broadcast() };
})();
