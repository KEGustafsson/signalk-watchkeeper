#!/usr/bin/env node
// Records a Signal K server's delta stream for evaluate-recording.mjs: one
// JSON line per message with the time it was received ({"t", "d"}), and a
// line for each connection opening or closing ({"t", "event"}) - a server
// restart shows as a close and an open, and the evaluation restarts its
// engine there, as the plugin's restarts with the server.
//
//   node scripts/record-stream.mjs <out.ndjson> [ws://host:3000]
//
// Reads what the stream gives without logging in (most servers allow it);
// keeps going across restarts until stopped.

import fs from 'node:fs';

const [outPath, base = 'ws://localhost:3000'] = process.argv.slice(2);
if (!outPath) {
  console.error('usage: node scripts/record-stream.mjs <out.ndjson> [ws://host:3000]');
  process.exit(1);
}
if (typeof WebSocket !== 'function') {
  console.error('needs a Node.js with WebSocket (22 or later)');
  process.exit(1);
}
const out = fs.createWriteStream(outPath, { flags: 'a' });
const url = `${base.replace(/\/$/, '')}/signalk/v1/stream?subscribe=all&sendMeta=all`;

function connect() {
  const ws = new WebSocket(url);
  ws.onopen = () => out.write(`${JSON.stringify({ t: Date.now(), event: 'open' })}\n`);
  ws.onmessage = (message) => {
    try {
      out.write(`${JSON.stringify({ t: Date.now(), d: JSON.parse(message.data) })}\n`);
    } catch {
      // Not JSON: not a delta.
    }
  };
  ws.onclose = () => {
    out.write(`${JSON.stringify({ t: Date.now(), event: 'close' })}\n`);
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {};
}
connect();
