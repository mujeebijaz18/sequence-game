# 🂡 Sequence Online

Play the **Sequence** card/board game online with friends, right in the phone browser. No accounts, no server to run —
it's a static site (GitHub Pages) and players connect **peer-to-peer** (WebRTC via [PeerJS](https://peerjs.com)).

## How to play online
1. One player opens the site, enters a name and taps **Create a game**.
2. They share the 5-letter **room code** (or the invite link — the **Share** button) with friends.
3. Friends open the site, enter their name + code, tap **Join game**.
4. Host picks **2 or 3 teams** and taps **Start**. 2–12 players (players must split evenly into teams).

**Rules in the app:** tap **?** for the quick rules. 2 teams need 2 sequences, 3 teams need 1. Two-eyed jacks are wild,
one-eyed jacks remove an enemy chip, dead cards can be swapped once per turn, the ★ corners are free for everyone.

## Good to know
- The **host's page is the game server.** Host should keep the tab open (on a phone: keep the screen on). If the host
  refreshes or the phone sleeps, open the site again and tap **Resume your hosted game** — the same room code comes back
  and friends reconnect automatically (their cards and the board are saved in the host's browser).
- A friend who loses connection reconnects automatically, or taps **Rejoin game** on the home page.
- Works as a home-screen app (Add to Home Screen).
- Connection setup uses the public PeerJS cloud server for matchmaking plus free public STUN/TURN relays
  (Google STUN, Open Relay TURN). Those are best-effort free services; if some friend's network can't connect, swap in your
  own TURN server in `PEER_OPTS` at the top of `app.js`.

## Deploy on GitHub Pages
Repo → **Settings → Pages → Build and deployment → Source: "Deploy from a branch" → Branch: `main` / `(root)` → Save.**
Your game will be live at `https://<your-username>.github.io/<repo-name>/` in about a minute.

## Develop
```bash
npm test                 # rules engine tests (node, no dependencies)
python3 -m http.server   # then open http://localhost:8000 (open it in 2+ tabs/devices to test)
```
Files: `game.js` rules engine (pure, tested) · `app.js` UI + networking · `style.css` · `vendor/peerjs.min.js` (MIT).
`tests/e2e.py` / `tests/e2e_win.py` are optional browser tests (Playwright + Chrome) that run whole games over a fake network.
