/* Sequence – pure game rules. Works in the browser (window.SeqGame) and Node (module.exports). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeqGame = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SUITS = ['S', 'H', 'D', 'C'];
  const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const TEAM_NAMES = ['Blue', 'Green', 'Red'];

  // 10x10 board, "F" = free corner (counts for everybody). Jacks are not on the board.
  const LAYOUT = [
    'F 2S 3S 4S 5S 6S 7S 8S 9S F',
    '6C 5C 4C 3C 2C AH KH QH 10H 10S',
    '7C AS 2D 3D 4D 5D 6D 7D 9H QS',
    '8C KS 6C 5C 4C 3C 2C 8D 8H KS',
    '9C QS 7C 6H 5H 4H AH 9D 7H AS',
    '10C 10S 8C 7H 2H 3H KH 10D 6H 2D',
    'QC 9S 9C 8H 9H 10H QH QD 5H 3D',
    'KC 8S 10C QC KC AC AD KD 4H 4D',
    'AC 7S 6S 5S 4S 3S 2S 2H 3H 5D',
    'F AD KD QD 10D 9D 8D 7D 6D F',
  ];
  const BOARD = [].concat.apply([], LAYOUT.map((r) => r.split(' ')));
  const CORNERS = [0, 9, 90, 99];
  const CARD_CELLS = {};
  BOARD.forEach((c, i) => { if (c !== 'F') (CARD_CELLS[c] = CARD_CELLS[c] || []).push(i); });

  const suitOf = (card) => card.slice(-1);
  const rankOf = (card) => card.slice(0, -1);
  const fmt = (card) => rankOf(card) + GLYPH[suitOf(card)];
  // two-eyed jacks (D, C) are wild; one-eyed jacks (H, S) remove a chip
  function jackKind(card) {
    if (rankOf(card) !== 'J') return null;
    return suitOf(card) === 'D' || suitOf(card) === 'C' ? 'wild' : 'remove';
  }
  const handSize = (n) => (n === 2 ? 7 : n <= 4 ? 6 : n <= 6 ? 5 : n <= 9 ? 4 : 3);
  const teamOf = (S, seat) => seat % S.teams;

  function makeDeck() {
    const d = [];
    for (let k = 0; k < 2; k++) for (const s of SUITS) for (const r of RANKS) d.push(r + s);
    return d;
  }
  function shuffle(a, rng) {
    rng = rng || Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---- move legality (works on a state or on a player's view: needs board + locked) ----
  function legalCells(st, card, team) {
    const out = [];
    const k = jackKind(card);
    if (k === 'wild') {
      for (let i = 0; i < 100; i++) if (st.board[i] === null && !CORNERS.includes(i)) out.push(i);
    } else if (k === 'remove') {
      for (let i = 0; i < 100; i++) if (st.board[i] !== null && st.board[i] !== team && !st.locked[i]) out.push(i);
    } else {
      for (const i of CARD_CELLS[card] || []) if (st.board[i] === null) out.push(i);
    }
    return out;
  }
  // A "dead card": non-jack whose two spaces are both covered.
  const isDead = (st, card) => jackKind(card) === null && legalCells(st, card, 0).length === 0;
  const hasAnyMove = (st, hand, team) => hand.some((c) => legalCells(st, c, team).length > 0);

  // ---- sequences ----
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  function detect(S, cell, team) {
    const found = [];
    const r0 = Math.floor(cell / 10), c0 = cell % 10;
    for (const [dr, dc] of DIRS) {
      for (let k = 4; k >= 0; k--) {
        const cells = [];
        let ok = true;
        for (let j = 0; j < 5; j++) {
          const r = r0 + dr * (j - k), c = c0 + dc * (j - k);
          if (r < 0 || r > 9 || c < 0 || c > 9) { ok = false; break; }
          cells.push(r * 10 + c);
        }
        if (!ok) continue;
        let shared = 0;
        for (const i of cells) {
          if (CORNERS.includes(i)) continue;
          if (S.board[i] !== team) { ok = false; break; }
          if (S.locked[i]) shared++;
        }
        if (!ok || shared > 1) continue; // a new sequence may share at most one chip
        S.seqs.push({ team, cells });
        for (const i of cells) if (!CORNERS.includes(i)) S.locked[i] = true;
        found.push(cells);
      }
    }
    return found;
  }
  const countSeqs = (S, team) => S.seqs.filter((s) => s.team === team).length;

  // ---- game flow ----
  const err = (error) => ({ ok: false, error });
  const seatOf = (S, token) => S.players.findIndex((p) => p.token === token);
  const log = (S, msg) => { S.log.push(msg); if (S.log.length > 40) S.log.shift(); };

  function newLobby(room, hostToken, hostName) {
    return {
      phase: 'lobby', room, teams: 2, need: 2, timer: 20, deadline: null,
      players: [{ token: hostToken, name: hostName }],
      board: Array(100).fill(null), locked: Array(100).fill(false), seqs: [],
      deck: [], discard: [], hands: {}, turn: 0, exchanged: false, last: null, winner: null, log: [],
    };
  }

  function startGame(S, rng) {
    const n = S.players.length;
    if (n < 2) return err('Need at least 2 players');
    if (n > 12) return err('Max 12 players');
    if (n % S.teams !== 0) return err(`${n} players can't split evenly into ${S.teams} teams`);
    S.need = S.teams === 2 ? 2 : 1;
    S.board = Array(100).fill(null);
    S.locked = Array(100).fill(false);
    S.seqs = [];
    S.deck = shuffle(makeDeck(), rng);
    S.discard = [];
    S.hands = {};
    for (const p of S.players) S.hands[p.token] = [];
    for (let i = 0; i < handSize(n); i++) for (const p of S.players) S.hands[p.token].push(S.deck.pop());
    S.turn = 0; S.exchanged = false; S.last = null; S.winner = null; S.log = []; S.deadline = null;
    S.phase = 'playing';
    log(S, 'Game started — good luck!');
    return { ok: true };
  }

  function draw(S, rng) {
    if (!S.deck.length && S.discard.length) S.deck = shuffle(S.discard.splice(0), rng);
    return S.deck.pop();
  }
  const advance = (S) => { S.turn = (S.turn + 1) % S.players.length; S.exchanged = false; S.deadline = null; };

  function checkTurn(S, token) {
    if (S.phase !== 'playing') return err('Game is not in progress');
    if (seatOf(S, token) !== S.turn) return err("It's not your turn");
    return null;
  }

  function applyPlay(S, token, idx, cell, rng) {
    const bad = checkTurn(S, token);
    if (bad) return bad;
    const seat = S.turn, team = teamOf(S, seat), name = S.players[seat].name;
    const hand = S.hands[token], card = hand[idx];
    if (!card) return err('No such card');
    if (!legalCells(S, card, team).includes(cell)) return err('That spot is not allowed for this card');

    if (jackKind(card) === 'remove') {
      const victim = S.board[cell];
      S.board[cell] = null;
      S.last = { seat, cell, type: 'remove', card, victim };
      log(S, `${name} removed a chip with ${fmt(card)}`);
    } else {
      S.board[cell] = team;
      S.last = { seat, cell, type: 'place', card };
      const what = jackKind(card) === 'wild' ? `wild ${fmt(card)}` : fmt(card);
      log(S, `${name} played ${what}`);
      const made = detect(S, cell, team);
      if (made.length) log(S, `${TEAM_NAMES[team]} made ${made.length > 1 ? made.length + ' sequences' : 'a sequence'}!`);
    }
    hand.splice(idx, 1);
    S.discard.push(card);

    if (countSeqs(S, team) >= S.need) {
      S.phase = 'over';
      S.winner = team;
      log(S, `${TEAM_NAMES[team]} team wins!`);
      return { ok: true, won: true };
    }
    const next = draw(S, rng);
    if (next) hand.push(next);
    advance(S);
    return { ok: true };
  }

  function applyDead(S, token, idx, rng) {
    const bad = checkTurn(S, token);
    if (bad) return bad;
    if (S.exchanged) return err('You already swapped a dead card this turn');
    const hand = S.hands[token], card = hand[idx];
    if (!card || !isDead(S, card)) return err('That card is not dead');
    hand.splice(idx, 1);
    S.discard.push(card);
    const next = draw(S, rng);
    if (next) hand.push(next);
    S.exchanged = true;
    S.last = { seat: S.turn, cell: null, type: 'swap', card };
    log(S, `${S.players[S.turn].name} swapped a dead ${fmt(card)}`);
    return { ok: true };
  }

  function applySkip(S, token) {
    const bad = checkTurn(S, token);
    if (bad) return bad;
    const hand = S.hands[token], team = teamOf(S, S.turn);
    if (hasAnyMove(S, hand, team)) return err('You still have a move');
    if (!S.exchanged && hand.some((c) => isDead(S, c))) return err('Swap your dead card first');
    log(S, `${S.players[S.turn].name} passed (no moves)`);
    S.last = { seat: S.turn, cell: null, type: 'pass' };
    advance(S);
    return { ok: true };
  }

  // Turn timer ran out: swap a dead card if needed, then play a random legal move (or pass).
  function autoMove(S, rng) {
    if (S.phase !== 'playing') return err('Game is not in progress');
    rng = rng || Math.random;
    const seat = S.turn, p = S.players[seat], team = teamOf(S, seat), hand = S.hands[p.token];
    if (!S.exchanged) {
      const d = hand.findIndex((c) => isDead(S, c));
      if (d >= 0) applyDead(S, p.token, d, rng);
    }
    const opts = [];
    hand.forEach((c, i) => legalCells(S, c, team).forEach((cell) => opts.push([i, cell, c])));
    if (!opts.length) {
      const r = applySkip(S, p.token);
      if (r.ok) { S.last.auto = true; S.log[S.log.length - 1] = `⏱ ${p.name} ran out of time and passed`; }
      return r;
    }
    const plain = opts.filter((o) => !jackKind(o[2]));
    const pool = plain.length ? plain : opts;
    const [i, cell] = pool[Math.floor(rng() * pool.length)];
    log(S, `⏱ ${p.name} ran out of time — auto-played`);
    const r = applyPlay(S, p.token, i, cell, rng);
    if (S.last) S.last.auto = true;
    return r;
  }

  // What one player is allowed to see.
  function view(S, token, connected) {
    connected = connected || {};
    const seat = seatOf(S, token);
    return {
      phase: S.phase, room: S.room, teams: S.teams, need: S.need,
      timer: S.timer || 0, deadlineIn: S.deadline ? Math.max(0, S.deadline - Date.now()) : null,
      players: S.players.map((p, i) => ({
        name: p.name, seat: i, team: teamOf(S, i), connected: !!connected[p.token],
        cards: (S.hands[p.token] || []).length,
      })),
      board: S.board, locked: S.locked, seqs: S.seqs,
      seqCount: Array.from({ length: S.teams }, (_, t) => countSeqs(S, t)),
      turn: S.turn, exchanged: S.exchanged, last: S.last, winner: S.winner,
      deckCount: S.deck.length, log: S.log.slice(-12),
      you: seat, isHost: seat === 0, hand: (S.hands[token] || []).slice(),
    };
  }

  return {
    LAYOUT, BOARD, CORNERS, CARD_CELLS, TEAM_NAMES, GLYPH,
    suitOf, rankOf, fmt, jackKind, handSize, teamOf, makeDeck, shuffle,
    legalCells, isDead, hasAnyMove, detect, countSeqs,
    newLobby, startGame, applyPlay, applyDead, applySkip, autoMove, view, seatOf,
  };
});
