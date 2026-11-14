// Tiny local MQTT-over-WebSocket broker for tests.  usage: NODE_PATH=<dir with aedes+ws> node tests/broker.js <port>
const aedes = require('aedes')();
const http = require('http');
const { WebSocketServer, createWebSocketStream } = require('ws');
const server = http.createServer();
const wss = new WebSocketServer({ server, handleProtocols: (p) => (p.has('mqtt') ? 'mqtt' : false) });
wss.on('connection', (ws) => aedes.handle(createWebSocketStream(ws)));
server.listen(+process.argv[2] || 18830, '127.0.0.1', () => console.log('broker up'));
