// End-to-end test for the Omnipotent extension. No dependencies — it drives Chrome
// over the DevTools protocol using Node's built-in fetch and WebSocket.
//
//   node tools/e2e.mjs            # headless
//   node tools/e2e.mjs --headful  # real window, parked off-screen
//
// It launches Chrome with the extension loaded, a fake camera/mic, and an
// auto-selected capture source, then drives two real recordings (MP4 and WebM)
// through the service worker and checks what actually landed in IndexedDB:
// duration, dimensions, seekability, thumbnail, chunk cleanup, overlay teardown.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
const PORT = 8765;
const CDP_PORT = 9333;
const TAB_TITLE = 'OMNIPOTENT-E2E';
const HEADFUL = process.argv.includes('--headful');
const OUT_FILE = join(tmpdir(), 'omnipotent-e2e-recording.mp4');
const WEBM_FILE = join(tmpdir(), 'omnipotent-e2e-recording.webm');

const log = (...args) => console.log('•', ...args);
const problems = [];

/* --------------------------------------------------------------- test page */

const pageHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${TAB_TITLE}</title>
<style>body{margin:0;background:#1e1b4b;color:#fff;font:600 20px system-ui}
 .row{padding:14px;display:flex;gap:12px;align-items:center}
 #pad{display:block;background:#fff;border:1px solid #ccc}
 #t{padding:14px;font-size:34px}</style></head>
<body>
 <div class="row">
   <input id="field" placeholder="type here" style="font-size:18px;padding:8px;width:240px">
   <button id="btn" style="font-size:18px;padding:8px 16px">CLICK ME</button>
   <span id="clicks">0</span>
 </div>
 <canvas id="pad" width="900" height="330"></canvas>
 <div id="t">frame 0</div>
<script>
 let n=0;setInterval(()=>{document.getElementById('t').textContent='frame '+(++n)},100);
 let clicks=0;
 document.getElementById('btn').addEventListener('click',()=>{
   clicks++;document.getElementById('clicks').textContent=String(clicks);});
 const pad=document.getElementById('pad'),ctx=pad.getContext('2d');
 window.__strokes=0;let drawing=false;
 pad.addEventListener('pointerdown',e=>{drawing=true;ctx.beginPath();
   ctx.moveTo(e.offsetX,e.offsetY);window.__strokes++;});
 pad.addEventListener('pointermove',e=>{if(!drawing)return;
   ctx.lineTo(e.offsetX,e.offsetY);ctx.lineWidth=4;ctx.stroke();});
 window.addEventListener('pointerup',()=>{drawing=false;});
</script>
</body></html>`;

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
log(`test page on http://127.0.0.1:${PORT}`);

/* ------------------------------------------------------------------ chrome */

const profile = mkdtempSync(join(tmpdir(), 'omnipotent-e2e-'));

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
const args = [
  ...(HEADFUL ? [] : ['--headless=new']),
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${EXT}`,
  `--load-extension=${EXT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=DialMediaRouteProvider,Translate',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--auto-select-desktop-capture-source=${TAB_TITLE}`,
  '--autoplay-policy=no-user-gesture-required',
  '--window-position=-3000,-3000',
  '--window-size=1280,800',
  'about:blank',
];

const chrome = spawn('google-chrome', args, { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stderr.on('data', (buffer) => {
  const text = buffer.toString();
  for (const line of text.split('\n')) {
    if (/ERROR|Extension|extension/.test(line) && line.trim()) console.log('  [chrome]', line.trim());
  }
});

async function waitForCdp() {
  for (let i = 0; i < 100; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error('CDP never came up');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const version = await waitForCdp();
log(`chrome up: ${version.Browser}`);

/* --------------------------------------------------------------------- CDP */

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const sessions = new Map(); // sessionId -> targetInfo

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  ws.send(JSON.stringify(message));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30000);
  });
}

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
    else resolve(msg.result);
    return;
  }

  if (msg.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = msg.params;
    sessions.set(sessionId, targetInfo);
    send('Runtime.enable', {}, sessionId).catch(() => {});
    send('Log.enable', {}, sessionId).catch(() => {});
    return;
  }
  if (msg.method === 'Target.detachedFromTarget') {
    sessions.delete(msg.params.sessionId);
    return;
  }

  const where = shortName(sessions.get(msg.sessionId)?.url);
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    const level = msg.params.type;
    if (level === 'error' || level === 'warning') {
      console.log(`  [${where}] ${level}: ${text}`);
      if (level === 'error') problems.push(`${where}: ${text}`);
    }
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const details = msg.params.exceptionDetails;
    const text = details.exception?.description || details.text;
    console.log(`  [${where}] EXCEPTION: ${text}`);
    problems.push(`${where}: ${text}`);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    console.log(`  [${where}] log-error: ${msg.params.entry.text}`);
  }
};

function shortName(url = '?') {
  return url.replace(/^chrome-extension:\/\/[a-z]+\//, 'ext:').replace(/^http:\/\/127\.0\.0\.1:\d+\//, 'page:');
}

await send('Target.setDiscoverTargets', { discover: true });
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

/* -------------------------------------------------------- find the extension */

async function findExtensionId() {
  for (let i = 0; i < 60; i += 1) {
    const { targetInfos } = await send('Target.getTargets');
    const worker = targetInfos.find(
      (t) => t.type === 'service_worker' && t.url.startsWith('chrome-extension://'),
    );
    if (worker) return new URL(worker.url).host;
    await sleep(250);
  }
  return null;
}

const extensionId = await findExtensionId();
if (!extensionId) {
  console.error('✗ extension service worker never registered');
  await shutdown(1);
}
log(`extension id: ${extensionId}`);

/* ------------------------------------------------------------- open targets */

async function openTab(url) {
  const { targetId } = await send('Target.createTarget', { url });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  return { targetId, sessionId };
}

async function evaluate(sessionId, expression, { awaitPromise = true } = {}) {
  const result = await send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

const page = await openTab(`http://127.0.0.1:${PORT}/`);
log('opened recording target tab');
await sleep(700);

const libraryUrl = `chrome-extension://${extensionId}/library/library.html`;
const library = await openTab(libraryUrl);
log('opened library page');
await sleep(700);

// Popup and permission pages: load them to prove their module graphs execute.
const popup = await openTab(`chrome-extension://${extensionId}/popup/popup.html`);
await sleep(600);
const popupReady = await evaluate(
  popup.sessionId,
  `(() => ({ start: !!document.getElementById('start-btn'),
             formats: [...document.getElementById('format').options].map(o => o.value) }))()`,
);
log(`popup rendered, formats offered: ${popupReady.formats.join(', ')}`);
if (!popupReady.start) problems.push('popup did not render its start button');

const permissions = await openTab(`chrome-extension://${extensionId}/permissions/permissions.html`);
await sleep(900);
const permStatus = await evaluate(
  permissions.sessionId,
  `document.getElementById('mic-status').textContent + '/' + document.getElementById('cam-status').textContent`,
);
log(`permissions page: mic ${permStatus}`);

/* ------------------------------------------------------------- the recording */

// Close the inspection tabs and make the recording target active again.
await send('Target.closeTarget', { targetId: popup.targetId });
await send('Target.closeTarget', { targetId: permissions.targetId });
await send('Target.activateTarget', { targetId: page.targetId });
await sleep(500);

log('sending start-recording…');
const startResult = await evaluate(
  library.sessionId,
  `chrome.runtime.sendMessage({ target: 'worker', type: 'start-recording' })`,
);
log(`worker replied: ${JSON.stringify(startResult)}`);
if (startResult && startResult.ok === false) {
  problems.push(`start failed: ${startResult.error || 'cancelled'}`);
}

// countdown (3s) + a few seconds of capture
for (let i = 0; i < 9; i += 1) {
  await sleep(1000);
  const state = await evaluate(
    library.sessionId,
    `chrome.runtime.sendMessage({ target: 'worker', type: 'get-state' })`,
  );
  if (i === 1 || i === 4 || i === 8) log(`  t+${i + 1}s phase=${state?.phase}`);
  if (i === 8 && state?.phase !== 'recording') {
    problems.push(`expected phase 'recording' at t+9s, got '${state?.phase}'`);
  }
}

// Exercise pause/resume and mic mute on the way through.
await evaluate(library.sessionId, `chrome.runtime.sendMessage({ target: 'worker', type: 'pause' })`);
await sleep(1200);
const pausedState = await evaluate(
  library.sessionId,
  `chrome.runtime.sendMessage({ target: 'worker', type: 'get-state' })`,
);
log(`  paused → phase=${pausedState?.phase}`);
if (pausedState?.phase !== 'paused') problems.push('pause did not take effect');
await evaluate(library.sessionId, `chrome.runtime.sendMessage({ target: 'worker', type: 'resume' })`);
await evaluate(
  library.sessionId,
  `chrome.runtime.sendMessage({ target: 'worker', type: 'set-mic-muted', muted: true })`,
);
await sleep(2000);

// Check the overlay actually mounted in the recorded page. (The __omnipotentOverlay
// flag lives in the content script's isolated world, so only the host node is
// visible from here.)
const overlayHost = await evaluate(
  page.sessionId,
  `!!document.getElementById('__omnipotent_overlay__')`,
);
log(`overlay host in page: ${overlayHost}`);
if (!overlayHost) problems.push('overlay host was not injected into the recorded page');

// The camera bubble is an extension-origin iframe, so it runs out-of-process and
// shows up as its own CDP target rather than a child frame of the page.
const overlayTargets = (await send('Target.getTargets')).targetInfos.filter((t) =>
  /overlay\/camera\.html/.test(t.url),
);
log(`camera iframe: ${overlayTargets.length ? 'present' : 'none'}`);
if (!overlayTargets.length) problems.push('camera bubble iframe missing');

// The control bar is drawn straight into a closed shadow root, so page script
// cannot see it — walk the DOM with pierce instead.
await send('DOM.enable', {}, page.sessionId).catch(() => {});
const { root: domRoot } = await send('DOM.getDocument', { depth: -1, pierce: true }, page.sessionId);

function findByClass(node, className) {
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i += 2) {
    if (attrs[i] === 'class' && new RegExp(`(^|\\s)${className}(\\s|$)`).test(attrs[i + 1])) {
      return node;
    }
  }
  for (const list of [node.children, node.shadowRoots, node.contentDocument ? [node.contentDocument] : []]) {
    for (const child of list || []) {
      const found = findByClass(child, className);
      if (found) return found;
    }
  }
  return null;
}

const barNode = findByClass(domRoot, 'bar');
const stopNode = findByClass(domRoot, 'stop');
log(`control bar in shadow DOM: ${!!barNode}, stop button: ${!!stopNode}`);
if (!barNode) problems.push('control bar was not drawn in the overlay shadow root');
if (!stopNode) problems.push('stop button missing from the control bar');

// And confirm the bubble has a live camera feed, not a black circle.
const camTarget = overlayTargets.find((t) => t.url.includes('camera.html'));
if (camTarget) {
  const r = await send('Target.attachToTarget', { targetId: camTarget.targetId, flatten: true }).catch(() => null);
  if (r) {
    // The bubble paints broadcast frames onto a canvas now, so "is it working"
    // means "have real pixels landed", not "is a video element playing".
    const cam = await evaluate(
      r.sessionId,
      `(() => {
         const c = document.getElementById('cam');
         const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
         let lit = 0;
         for (let i = 0; i < data.length; i += 4 * 89) {
           if (data[i] > 8 || data[i + 1] > 8 || data[i + 2] > 8) lit++;
         }
         return JSON.stringify({
           w: c.width, h: c.height, paintedPixels: lit,
           fallbackShown: document.getElementById('fallback').classList.contains('on'),
           fallbackText: document.getElementById('fallback').textContent.trim(),
         });
       })()`,
    ).catch((e) => `eval failed: ${e.message}`);
    log(`camera bubble feed: ${cam}`);
    const camData = (() => { try { return JSON.parse(cam); } catch { return null; } })();
    if (!camData || camData.paintedPixels === 0) {
      problems.push(`camera bubble received no frames (${cam})`);
    }
    if (camData?.fallbackShown) {
      problems.push(`camera bubble is showing a fallback: "${camData.fallbackText}"`);
    }
  }
}

// The overlay must never steal the page's input. Its host covers the whole
// viewport, so if it forgets pointer-events:none the page goes silently dead —
// clicks, typing and canvas drags all vanish while everything still looks fine.
async function pageClick(x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, page.sessionId);
  }
  await sleep(200);
}

const readPage = () =>
  evaluate(
    page.sessionId,
    `JSON.stringify({ clicks: +document.getElementById('clicks').textContent,
                      field: document.getElementById('field').value,
                      strokes: window.__strokes })`,
  );

const beforeInput = JSON.parse(await readPage());
await pageClick(330, 36); // the page's own button
await pageClick(140, 36); // focus the text field
await send('Input.insertText', { text: 'typed-while-recording' }, page.sessionId);
// A canvas drag, i.e. the Excalidraw case.
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 200, y: 200, button: 'left', clickCount: 1 }, page.sessionId);
for (let i = 1; i <= 6; i += 1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200 + i * 40, y: 200 + i * 15, button: 'left' }, page.sessionId);
}
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 440, y: 290, button: 'left' }, page.sessionId);
await sleep(250);
const afterInput = JSON.parse(await readPage());
log(`page interaction while recording: ${JSON.stringify(afterInput)}`);

if (afterInput.clicks <= beforeInput.clicks) problems.push('page button did not receive clicks while recording');
if (!afterInput.field.includes('typed-while-recording')) problems.push('could not type into the page while recording');
if (afterInput.strokes <= beforeInput.strokes) problems.push('canvas drags did not reach the page while recording');

log('stopping…');
await evaluate(library.sessionId, `chrome.runtime.sendMessage({ target: 'worker', type: 'stop' })`);

/* -------------------------------------------------------------- verify saved */

async function readRecordings(sessionId) {
  return evaluate(
    sessionId,
    `new Promise((resolve, reject) => {
       const req = indexedDB.open('omnipotent');
       req.onerror = () => reject(req.error);
       req.onsuccess = () => {
         const db = req.result;
         const tx = db.transaction(['recordings','chunks'], 'readonly');
         const recs = tx.objectStore('recordings').getAll();
         const chunkCount = tx.objectStore('chunks').count();
         tx.oncomplete = () => resolve({
           chunksLeft: chunkCount.result,
           recordings: recs.result.map(r => ({
             id: r.id, title: r.title, size: r.blob ? r.blob.size : 0,
             blobType: r.blob ? r.blob.type : null,
             durationMs: r.durationMs, mimeType: r.mimeType, ext: r.ext,
             width: r.width, height: r.height, hasMic: r.hasMic, hasCamera: r.hasCamera,
             thumb: r.thumbnail ? r.thumbnail.slice(0, 24) + '…' : null,
           })),
         });
         tx.onerror = () => reject(tx.error);
       };
     })`,
  );
}

let saved = null;
for (let i = 0; i < 25; i += 1) {
  await sleep(600);
  const data = await readRecordings(library.sessionId);
  if (data.recordings.length) {
    saved = data;
    break;
  }
}

console.log('\n──────── result ────────');
if (!saved) {
  problems.push('no recording was written to IndexedDB');
  console.log('✗ nothing saved');
} else {
  const rec = saved.recordings[0];
  console.log(JSON.stringify(rec, null, 2));
  console.log(`chunks left behind: ${saved.chunksLeft}`);
  if (!rec.size) problems.push('saved recording is 0 bytes');
  if (!rec.durationMs) problems.push('saved recording has no duration');
  if (saved.chunksLeft !== 0) problems.push(`${saved.chunksLeft} chunk rows were not cleaned up`);
  if (!rec.thumb) problems.push('no thumbnail was generated');

  // Bring the library tab to the front: a background tab defers media loading.
  await send('Target.activateTarget', { targetId: library.targetId });
  await sleep(600);

  // Export the actual bytes so ffprobe can vouch for the file.
  const b64 = await evaluate(
    library.sessionId,
    `(async () => {
       const req = indexedDB.open('omnipotent');
       const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
       const rec = await new Promise((res, rej) => {
         const r = db.transaction('recordings').objectStore('recordings').getAll();
         r.onsuccess = () => res(r.result[0]); r.onerror = () => rej(r.error);
       });
       const buf = await rec.blob.arrayBuffer();
       let s = '';
       const bytes = new Uint8Array(buf);
       for (let i = 0; i < bytes.length; i += 0x8000) {
         s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
       }
       return btoa(s);
     })()`,
  );
  writeFileSync(OUT_FILE, Buffer.from(b64, 'base64'));
  console.log(`exported ${OUT_FILE} (${Buffer.from(b64, 'base64').length} bytes)`);

  // Play it back to prove the file is decodable and seekable.
  const playback = await evaluate(
    library.sessionId,
    `(async () => {
       const req = indexedDB.open('omnipotent');
       const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
       const rec = await new Promise((res, rej) => {
         const r = db.transaction('recordings').objectStore('recordings').getAll();
         r.onsuccess = () => res(r.result[0]); r.onerror = () => rej(r.error);
       });
       const v = document.createElement('video');
       v.muted = true;
       v.src = URL.createObjectURL(rec.blob);
       document.body.appendChild(v);
       const meta = await new Promise((res) => {
         v.onloadedmetadata = () => res({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
         v.onerror = () => res({ error: String(v.error && v.error.message) });
         setTimeout(() => res({ error: 'metadata timeout' }), 12000);
       });
       if (meta.error) return meta;
       // Seek to the middle and confirm the scrubber actually lands there.
       const target = Math.max(0.1, meta.duration / 2);
       const seeked = await new Promise((res) => {
         v.onseeked = () => res(v.currentTime);
         v.currentTime = target;
         setTimeout(() => res(null), 6000);
       });
       v.remove();
       return { ...meta, seekTarget: target, seekedTo: seeked };
     })()`,
  );
  console.log('playback probe:', JSON.stringify(playback));
  if (playback.error) problems.push(`playback failed: ${playback.error}`);
  else if (!playback.w) problems.push('decoded video has no dimensions');
}

// Overlay must be gone after the session ends.
const overlayAfter = await evaluate(
  page.sessionId,
  `!!document.getElementById('__omnipotent_overlay__')`,
).catch(() => 'unknown');
console.log('overlay still present after stop:', overlayAfter);
if (overlayAfter === true) problems.push('overlay was not torn down after stop');

const offscreenGone = await evaluate(
  library.sessionId,
  `chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).then(c => c.length)`,
);
console.log('offscreen documents left:', offscreenGone);
if (offscreenGone !== 0) problems.push('offscreen document was not closed');

/* ------------------------------------------------ second pass: WebM + tab audio */

console.log('\n──────── pass 2: WebM + tab audio ────────');
await evaluate(
  library.sessionId,
  `chrome.storage.local.get('settings').then(({settings}) => chrome.storage.local.set({
     settings: { ...(settings||{}), format: 'webm', useTabAudio: true, countdownSeconds: 0 }
   }))`,
);
await send('Target.activateTarget', { targetId: page.targetId });
await sleep(400);
const start2 = await evaluate(
  library.sessionId,
  `chrome.runtime.sendMessage({ target: 'worker', type: 'start-recording' })`,
);
console.log('start →', JSON.stringify(start2));
await sleep(6000);
const phase2 = await evaluate(
  library.sessionId,
  `chrome.runtime.sendMessage({ target: 'worker', type: 'get-state' })`,
);
console.log('phase →', phase2?.phase);
if (phase2?.phase !== 'recording') problems.push(`pass 2: expected recording, got ${phase2?.phase}`);
await evaluate(library.sessionId, `chrome.runtime.sendMessage({ target: 'worker', type: 'stop' })`);

let webm = null;
for (let i = 0; i < 25 && !webm; i += 1) {
  await sleep(600);
  const data = await readRecordings(library.sessionId);
  webm = data.recordings.find((r) => r.ext === 'webm') || null;
}
if (!webm) {
  problems.push('pass 2: no WebM recording was saved');
  console.log('✗ no WebM recording saved');
} else {
  console.log(JSON.stringify(webm, null, 1));
  await send('Target.activateTarget', { targetId: library.targetId });
  await sleep(600);
  const webmPlayback = await evaluate(
    library.sessionId,
    `(async () => {
       const req = indexedDB.open('omnipotent');
       const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
       const rec = await new Promise((res, rej) => {
         const r = db.transaction('recordings').objectStore('recordings').getAll();
         r.onsuccess = () => res(r.result.find(x => x.ext === 'webm')); r.onerror = () => rej(r.error);
       });
       const v = document.createElement('video');
       v.muted = true; document.body.appendChild(v);
       v.src = URL.createObjectURL(rec.blob);
       const before = await new Promise((res) => {
         v.onloadedmetadata = () => res(v.duration);
         v.onerror = () => res('error');
         setTimeout(() => res('timeout'), 12000);
       });
       // The library's fix: force a seek past the end so Chrome learns the duration.
       let after = before;
       if (before === Infinity) {
         after = await new Promise((res) => {
           const onUpdate = () => { v.removeEventListener('timeupdate', onUpdate); v.currentTime = 0; res(v.duration); };
           v.addEventListener('timeupdate', onUpdate);
           v.currentTime = 1e101;
           setTimeout(() => res('fix timeout'), 8000);
         });
       }
       const seeked = await new Promise((res) => {
         v.onseeked = () => res(v.currentTime);
         v.currentTime = 1.0;
         setTimeout(() => res(null), 6000);
       });
       const out = { durationBefore: before, durationAfter: after, audioTracks: rec.hasTabAudio, seekedTo: seeked, w: v.videoWidth };
       v.remove();
       return out;
     })()`,
  );
  console.log('webm playback:', JSON.stringify(webmPlayback));

  // Export it so ffprobe/ffmpeg can confirm the mic+tab-audio mixer produced
  // real sound rather than a silent track.
  const webmB64 = await evaluate(
    library.sessionId,
    `(async () => {
       const req = indexedDB.open('omnipotent');
       const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
       const rec = await new Promise((res, rej) => {
         const r = db.transaction('recordings').objectStore('recordings').getAll();
         r.onsuccess = () => res(r.result.find(x => x.ext === 'webm')); r.onerror = () => rej(r.error);
       });
       const bytes = new Uint8Array(await rec.blob.arrayBuffer());
       let s = '';
       for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
       return btoa(s);
     })()`,
  );
  writeFileSync(WEBM_FILE, Buffer.from(webmB64, 'base64'));
  console.log(`exported ${WEBM_FILE}`);
  if (!webmPlayback.w) problems.push('pass 2: WebM did not decode');
  if (webmPlayback.seekedTo === null) problems.push('pass 2: WebM would not seek even after the duration fix');
}

console.log('────────────────────────');
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`);
  for (const p of problems) console.log('  -', p);
} else {
  console.log('\n✓ all checks passed');
}

await shutdown(problems.length ? 1 : 0);

async function shutdown(code) {
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL');
  server.close();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(code);
}
