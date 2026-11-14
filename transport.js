/* Relay transport with the same tiny API the game uses from PeerJS (Peer / connect / on / send / close).
   Messages travel through a free public MQTT-over-WebSocket broker, so it works on every network
   (mobile data, CGNAT, strict routers) — no WebRTC / NAT traversal needed. */
(function () {
  'use strict';
  const BROKERS = window.SEQ_BROKERS || [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
  ];
  const NS = 'seqg1/';
  const rand = () => Math.random().toString(36).slice(2, 10);

  class Conn {
    constructor(peer, remote, cid) {
      this.peer = peer; this.peerId = remote; this.id = cid; this.open = false; this.h = {};
      peer._conns[cid] = this;
    }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
    emit(e, a) { (this.h[e] || []).slice().forEach((f) => { try { f(a); } catch (err) { console.error(err); } }); }
    send(d) { this.peer._pub(this.peerId, { k: 'data', from: this.peer.id, cid: this.id, d }); }
    close() {
      if (!this.open) return;
      this.open = false;
      this.peer._pub(this.peerId, { k: 'close', from: this.peer.id, cid: this.id });
      this.emit('close');
    }
  }

  class Peer {
    constructor(id) {
      if (id && typeof id === 'object') id = null;
      this.id = id || 'c' + rand() + rand();
      this.h = {}; this._conns = {}; this.open = false; this.disconnected = false; this.destroyed = false;
      this._bi = 0; this._fails = 0; this._watch = {};
      this._connect();
    }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
    emit(e, a) { (this.h[e] || []).slice().forEach((f) => { try { f(a); } catch (err) { console.error(err); } }); }

    _connect() {
      if (this.destroyed) return;
      const url = BROKERS[this._bi % BROKERS.length];
      const presence = NS + this.id + '/presence';
      const mq = (this.mq = mqtt.connect(url, {
        clientId: 'seq_' + this.id + '_' + rand(), keepalive: 20, reconnectPeriod: 2000, connectTimeout: 8000, clean: true,
        will: { topic: presence, payload: 'offline', retain: true, qos: 0 },
      }));
      mq.on('connect', () => {
        this._fails = 0;
        mq.subscribe(NS + this.id + '/in', { qos: 0 }, (err) => {
          if (err || this.destroyed) return;
          mq.publish(presence, 'online', { retain: true });
          Object.keys(this._watch).forEach((p) => mq.subscribe(NS + p + '/presence'));
          this.disconnected = false;
          if (!this.open) { this.open = true; this.emit('open', this.id); }
        });
      });
      mq.on('message', (topic, payload) => this._onMsg(topic, payload.toString()));
      mq.on('close', () => {
        if (this.destroyed) return;
        this.disconnected = true;
        if (!this.open) {
          if (++this._fails >= 2) { // this broker looks down: try the next one
            this._fails = 0; this._bi++;
            try { mq.end(true); } catch (e) { /* ignore */ }
            if (this._bi % BROKERS.length === 0) this.emit('error', { type: 'network', message: 'Could not reach any relay server' });
            this._connect();
          }
        } else this.emit('disconnected');
      });
      mq.on('error', () => {});
    }

    _pub(to, msg) {
      if (this.mq && this.mq.connected) this.mq.publish(NS + to + '/in', JSON.stringify(msg), { qos: 0 });
    }
    _watchPeer(p) {
      this._watch[p] = true;
      if (this.mq && this.mq.connected) this.mq.subscribe(NS + p + '/presence');
    }

    _onMsg(topic, str) {
      if (topic.endsWith('/presence')) {
        const pid = topic.slice(NS.length, -'/presence'.length);
        if (str === 'offline') Object.values(this._conns).forEach((c) => { if (c.peerId === pid && c.open) { c.open = false; c.emit('close'); } });
        return;
      }
      let m; try { m = JSON.parse(str); } catch (e) { return; }
      if (!m || !m.cid) return;
      if (m.k === 'hello') {
        let c = this._conns[m.cid];
        if (!c) {
          c = new Conn(this, m.from, m.cid); c.open = true;
          this._watchPeer(m.from);
          this._pub(m.from, { k: 'accept', from: this.id, cid: m.cid });
          this.emit('connection', c);
          setTimeout(() => c.emit('open'), 0);
        } else this._pub(m.from, { k: 'accept', from: this.id, cid: m.cid }); // accept got lost: resend
      } else if (m.k === 'accept') {
        const c = this._conns[m.cid];
        if (c && !c.open) { c.open = true; clearTimeout(c._t); clearInterval(c._hi); c.emit('open'); }
      } else if (m.k === 'data') {
        const c = this._conns[m.cid]; if (c && c.open) c.emit('data', m.d);
      } else if (m.k === 'close') {
        const c = this._conns[m.cid]; if (c && c.open) { c.open = false; c.emit('close'); }
      }
    }

    connect(remote) {
      const cid = 'k' + rand() + rand();
      const c = new Conn(this, remote, cid);
      this._watchPeer(remote);
      const hello = () => this._pub(remote, { k: 'hello', from: this.id, cid });
      const start = Date.now();
      const trySend = () => { if (this.mq && this.mq.connected) hello(); };
      trySend();
      c._hi = setInterval(() => { if (c.open || Date.now() - start > 9000) clearInterval(c._hi); else trySend(); }, 1500);
      c._t = setTimeout(() => { if (!c.open) this.emit('error', { type: 'peer-unavailable', message: 'No reply from ' + remote }); }, 9000);
      return c;
    }
    reconnect() { /* mqtt.js reconnects on its own */ }
    destroy() {
      if (this.destroyed) return;
      Object.values(this._conns).forEach((c) => { try { c.close(); } catch (e) { /* ignore */ } });
      this.destroyed = true;
      try { this.mq.publish(NS + this.id + '/presence', 'offline', { retain: true }); } catch (e) { /* ignore */ }
      setTimeout(() => { try { this.mq.end(true); } catch (e) { /* ignore */ } }, 150);
    }
  }
  window.Peer = Peer;
})();
