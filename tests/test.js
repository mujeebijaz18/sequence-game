const assert = require('assert');
const G = require('../game.js');

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

// deterministic rng
function seeded(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function lobby(n, teams) {
  const S = G.newLobby('TEST1', 't0', 'P0');
  for (let i = 1; i < n; i++) S.players.push({ token: 't' + i, name: 'P' + i });
  S.teams = teams;
  return S;
}

test('board has 100 cells, 4 corners, each non-jack card exactly twice', () => {
  assert.strictEqual(G.BOARD.length, 100);
  assert.deepStrictEqual(G.BOARD.map((c, i) => (c === 'F' ? i : -1)).filter((i) => i >= 0), [0, 9, 90, 99]);
  const deck = new Set(G.makeDeck().filter((c) => G.rankOf(c) !== 'J'));
  assert.strictEqual(deck.size, 48);
  for (const c of deck) assert.strictEqual(G.CARD_CELLS[c].length, 2, 'card ' + c);
  assert.strictEqual(Object.keys(G.CARD_CELLS).length, 48);
});

test('deal sizes by player count and deck conservation', () => {
  for (const [n, t, hs] of [[2, 2, 7], [3, 3, 6], [4, 2, 6], [6, 2, 5], [6, 3, 5]]) {
    const S = lobby(n, t);
    assert.ok(G.startGame(S, seeded(1)).ok);
    for (const p of S.players) assert.strictEqual(S.hands[p.token].length, hs);
    assert.strictEqual(S.deck.length + n * hs, 104);
  }
  assert.ok(!G.startGame(lobby(5, 2)).ok); // uneven
  assert.ok(!G.startGame(lobby(1, 2)).ok);
});

test('jack rules', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(2));
  S.board[11] = 1; // opponent chip (team 1)
  S.board[12] = 0; // own chip
  S.locked[13] = true; S.board[13] = 1; // locked opponent chip
  assert.deepStrictEqual(G.legalCells(S, 'JH', 0).sort((a, b) => a - b), [11]);
  assert.ok(!G.legalCells(S, 'JD', 0).includes(0)); // corner excluded
  assert.ok(!G.legalCells(S, 'JC', 0).includes(11)); // occupied excluded
  assert.strictEqual(G.legalCells(S, 'JD', 0).length, 100 - 4 - 3);
});

test('normal move, draw, turn advance, wrong-turn rejection', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(3));
  S.hands.t0 = ['9C', 'JD', '2S', '3S', '4S', '5S', '6S'];
  assert.ok(!G.applyPlay(S, 't1', 0, 10).ok);
  const cell = G.CARD_CELLS['9C'][0];
  assert.ok(!G.applyPlay(S, 't0', 0, 55).ok); // illegal spot
  const r = G.applyPlay(S, 't0', 0, cell, seeded(9));
  assert.ok(r.ok);
  assert.strictEqual(S.board[cell], 0);
  assert.strictEqual(S.hands.t0.length, 7);
  assert.strictEqual(S.turn, 1);
});

test('five in a row makes a sequence and locks chips; 2 teams need 2', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(4));
  for (let c = 0; c < 4; c++) S.board[40 + c] = 0; // row 4, cols 0-3
  S.hands.t0 = ['JD', 'AS', 'AS', 'AS', 'AS', 'AS', 'AS'];
  const r = G.applyPlay(S, 't0', 0, 44, seeded(1));
  assert.ok(r.ok && !r.won);
  assert.strictEqual(G.countSeqs(S, 0), 1);
  assert.ok([40, 41, 42, 43, 44].every((i) => S.locked[i]));
  assert.strictEqual(S.phase, 'playing');
});

test('3 teams: single sequence wins; corner counts as wild', () => {
  const S = lobby(3, 3); G.startGame(S, seeded(5));
  [1, 2, 3].forEach((i) => (S.board[i] = 0)); // corner 0 + cells 1..3
  S.hands.t0 = ['JC', '2S', '2S', '2S', '2S', '2S'];
  const r = G.applyPlay(S, 't0', 0, 4, seeded(1)); // corner + 1..4 = five
  assert.ok(r.ok && r.won);
  assert.strictEqual(S.winner, 0);
  assert.strictEqual(S.phase, 'over');
});

test('six in a row is one sequence; nine in a row is two (share one)', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(6));
  // row 5: cols 0..5 -> placing col 2 last creates 6 in a row
  [50, 51, 53, 54, 55].forEach((i) => (S.board[i] = 0));
  S.hands.t0 = ['JD', 'AS', 'AS', 'AS', 'AS', 'AS', 'AS'];
  assert.ok(G.applyPlay(S, 't0', 0, 52, seeded(1)).ok);
  assert.strictEqual(G.countSeqs(S, 0), 1);

  const T = lobby(2, 2); G.startGame(T, seeded(7));
  [60, 61, 62, 63, 65, 66, 67, 68].forEach((i) => (T.board[i] = 0));
  T.hands.t0 = ['JD', 'AS', 'AS', 'AS', 'AS', 'AS', 'AS'];
  const r = G.applyPlay(T, 't0', 0, 64, seeded(1));
  assert.ok(r.won, 'nine in a row = 2 sequences');
  assert.strictEqual(G.countSeqs(T, 0), 2);
});

test('locked chips cannot be removed; one-eyed jack removes others', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(8));
  S.board[30] = 1; S.board[31] = 1; S.locked[31] = true;
  S.hands.t0 = ['JH', 'AS', 'AS', 'AS', 'AS', 'AS', 'AS'];
  assert.ok(!G.applyPlay(S, 't0', 0, 31).ok);
  assert.ok(G.applyPlay(S, 't0', 0, 30, seeded(1)).ok);
  assert.strictEqual(S.board[30], null);
});

test('dead card swap once per turn; skip rules', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(9));
  const [a, b] = G.CARD_CELLS['KH'];
  S.board[a] = 1; S.board[b] = 0;
  S.hands.t0 = ['KH', 'KH', 'AS', 'AS', 'AS', 'AS', 'AS'];
  assert.ok(G.isDead(S, 'KH'));
  assert.ok(G.applyDead(S, 't0', 0, seeded(1)).ok);
  assert.ok(!G.applyDead(S, 't0', 0, seeded(1)).ok); // second swap same turn
  assert.ok(!G.applySkip(S, 't0').ok); // still has moves
  S.hands.t1 = ['KH']; S.turn = 1; S.exchanged = true;
  assert.ok(G.applySkip(S, 't1').ok);
  assert.strictEqual(S.turn, 0);
});

test('autoMove plays a legal move or passes, and records last', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(11));
  const r = G.autoMove(S, seeded(3));
  assert.ok(r.ok);
  assert.strictEqual(S.turn, 1);
  assert.ok(S.last && S.last.auto && S.last.type === 'place');
  assert.strictEqual(S.deadline, null);
  assert.ok(typeof G.view(S, 't0').timer === 'number');
  // remove records victim
  const T = lobby(2, 2); G.startGame(T, seeded(12));
  T.board[30] = 1; T.hands.t0 = ['JH', 'AS', 'AS', 'AS', 'AS', 'AS', 'AS'];
  G.applyPlay(T, 't0', 0, 30, seeded(1));
  assert.strictEqual(T.last.victim, 1);
});

test('four-in-a-row flag and move counter', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(21));
  [40, 41, 42].forEach((i) => (S.board[i] = 0));
  S.hands.t0 = ['JD', 'AS', 'AS', 'AS', 'AS', 'AS', 'AS'];
  assert.ok(G.applyPlay(S, 't0', 0, 43, seeded(1)).ok);
  assert.strictEqual(S.last.four, true);
  assert.strictEqual(S.last.n, 1);
  const T = lobby(2, 2); G.startGame(T, seeded(22));
  T.hands.t0 = ['JD', 'AS', 'AS', 'AS', 'AS', 'AS', 'AS'];
  G.applyPlay(T, 't0', 0, 55, seeded(1));
  assert.ok(!T.last.four);
});

test('view hides other hands', () => {
  const S = lobby(2, 2); G.startGame(S, seeded(10));
  const v = G.view(S, 't1', { t0: true });
  assert.strictEqual(v.you, 1);
  assert.deepStrictEqual(v.hand, S.hands.t1);
  assert.strictEqual(v.players[0].cards, 7);
  assert.ok(!('hands' in v) && !('deck' in v));
});

test('random full games never break invariants (200 games)', () => {
  let finished = 0;
  for (let g = 0; g < 200; g++) {
    const rng = seeded(1000 + g);
    const n = [2, 3, 4, 6][g % 4];
    const S = lobby(n, n === 3 ? 3 : 2);
    assert.ok(G.startGame(S, rng).ok);
    for (let turn = 0; turn < 3000 && S.phase === 'playing'; turn++) {
      const p = S.players[S.turn], hand = S.hands[p.token], team = G.teamOf(S, S.turn);
      const total = S.deck.length + S.discard.length + Object.values(S.hands).reduce((a, h) => a + h.length, 0);
      assert.strictEqual(total, 104);
      const dead = hand.findIndex((c) => G.isDead(S, c));
      if (dead >= 0 && !S.exchanged) { assert.ok(G.applyDead(S, p.token, dead, rng).ok); continue; }
      const options = [];
      hand.forEach((c, i) => G.legalCells(S, c, team).forEach((cell) => options.push([i, cell])));
      if (!options.length) { assert.ok(G.applySkip(S, p.token).ok); continue; }
      const [i, cell] = options[Math.floor(rng() * options.length)];
      assert.ok(G.applyPlay(S, p.token, i, cell, rng).ok);
    }
    if (S.phase === 'over') finished++;
  }
  assert.ok(finished > 150, 'most random games finish, got ' + finished);
});

console.log(`\n${passed} tests passed`);
