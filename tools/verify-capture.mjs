// Proves Omnipotent captures REAL pixels.
//
//   node tools/verify-capture.mjs
//
// tools/e2e.mjs runs Chrome with --use-fake-device-for-media-stream, which swaps
// in a synthetic test pattern — great for exercising the pipeline, useless for
// proving that real screen content is what gets encoded. This script runs without
// any fake-device flags and records actual pixels.
//
// No --use-fake-device flags. Camera and mic are switched off in settings so
// nothing but the local test tab is ever captured; --auto-select-desktop-capture-source
// pins the picker to that tab by title, so the user's desktop is never recorded.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const PORT = 8771;
const CDP_PORT = 9342;
const TITLE = 'OMNIPOTENT-PIXELS';
const OUT = join(tmpdir(), 'omnipotent-real-pixels.mp4');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('unhandledRejection', (e) => console.log('  (rejection)', e.message));

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title>
<style>body{margin:0;height:100vh;background:#f5f0e6;color:#1b1b1b;
font:700 64px/1.3 system-ui;display:grid;place-items:center;text-align:center}
#c{color:#c2410c;font-size:104px}</style></head>
<body><div><div>Omnipotent captured this</div><div id="c">0</div></div>
<script>let n=0;setInterval(()=>{document.getElementById('c').textContent=(++n)},100)</script>
</body></html>`;

const server = createServer((_r, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml);
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

const profile = mkdtempSync(join(tmpdir(), 'omnipotent-px-'));

// A crashed run used to leave its throwaway Chrome profile behind; enough of
// those will fill a disk. Clean up however this process ends.
let cleanedUp = false;
function cleanupOnExit() {
  if (cleanedUp) return;
  cleanedUp = true;
  try { chrome.kill('SIGKILL'); } catch {}
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanupOnExit);
for (const sig of ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
  process.on(sig, (err) => {
    if (err && sig.startsWith('u')) console.error(`\n✗ ${sig}:`, err?.message || err);
    cleanupOnExit();
    process.exit(1);
  });
}
const chrome = spawn('google-chrome', [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  '--no-first-run',
  '--no-default-browser-check',
  `--auto-select-desktop-capture-source=${TITLE}`,
  '--window-size=1280,800',
  `http://127.0.0.1:${PORT}/`,
]);

let version;
for (let i = 0; i < 100 && !version; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
    if (res.ok) version = await res.json();
  } catch {}
  if (!version) await sleep(200);
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});
let id = 1;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const n = id++;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    setTimeout(() => pending.has(n) && (pending.delete(n), reject(new Error('timeout ' + method))), 25000);
  });

const targets = async () => (await send('Target.getTargets')).targetInfos;
let swT = null;
for (let i = 0; i < 60 && !swT; i += 1) {
  swT = (await targets()).find((t) => t.url.includes('background/service-worker.js')) || null;
  if (!swT) await sleep(250);
}
const extId = new URL(swT.url).host;

const { targetId: libId } = await send('Target.createTarget', {
  url: `chrome-extension://${extId}/library/library.html`,
});
const { sessionId: lib } = await send('Target.attachToTarget', { targetId: libId, flatten: true });
await sleep(1000);

const evaluate = async (sessionId, expression) => {
  const r = await send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

// Screen only: no camera, no mic, no countdown.
await evaluate(
  lib,
  `chrome.storage.local.set({ settings: { useMic: false, useCamera: false, useTabAudio: false,
     countdownSeconds: 0, format: 'mp4', quality: '1080p', fps: 30 } })`,
);

console.log('start →', JSON.stringify(await evaluate(lib, `chrome.runtime.sendMessage({target:'worker',type:'start-recording'})`)));
await sleep(5000);
console.log('phase →', (await evaluate(lib, `chrome.runtime.sendMessage({target:'worker',type:'get-state'})`))?.phase);
await evaluate(lib, `chrome.runtime.sendMessage({target:'worker',type:'stop'})`);

let b64 = null;
for (let i = 0; i < 25 && !b64; i += 1) {
  await sleep(600);
  b64 = await evaluate(
    lib,
    `(async () => {
       const req = indexedDB.open('omnipotent');
       const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
       const rec = await new Promise((res, rej) => {
         const r = db.transaction('recordings').objectStore('recordings').getAll();
         r.onsuccess = () => res(r.result[0]); r.onerror = () => rej(r.error);
       });
       if (!rec) return null;
       const bytes = new Uint8Array(await rec.blob.arrayBuffer());
       let s = '';
       for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
       return btoa(s);
     })()`,
  );
}

if (b64) {
  writeFileSync(OUT, Buffer.from(b64, 'base64'));
  console.log(`exported ${OUT} (${Buffer.from(b64, 'base64').length} bytes)`);
} else {
  console.log('✗ no recording saved');
}

ws.close();
chrome.kill('SIGKILL');
server.close();
await sleep(200);
rmSync(profile, { recursive: true, force: true });
process.exit(b64 ? 0 : 1);
