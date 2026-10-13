// Webcam bubble — a renderer, not a capturer.
//
// It deliberately never calls getUserMedia. A site can disable the camera for
// every frame it contains with `Permissions-Policy: camera=()`, and because that
// policy is inherited down the frame tree, an iframe cannot re-enable what the
// top document switched off — which is what used to kill the bubble on sites
// like claude.ai. The offscreen document owns the camera instead and broadcasts
// frames here, so this file needs no camera permission at all and works on any
// page. It is still ordinary page content, which is why the screen capture
// picks it up.

import { CAMERA_CHANNEL } from '../common/messages.js';
import { loadSettings, saveSettings } from '../common/settings.js';

const canvas = document.getElementById('cam');
const ctx = canvas.getContext('2d');
const fallback = document.getElementById('fallback');
const buttons = {
  sm: document.getElementById('size-sm'),
  md: document.getElementById('size-md'),
  lg: document.getElementById('size-lg'),
  mirror: document.getElementById('mirror'),
};

let settings = null;
let gotFrame = false;

function post(message) {
  window.parent.postMessage({ channel: 'omnipotent', ...message }, '*');
}

function showFallback(text) {
  fallback.textContent = text;
  fallback.classList.add('on');
}

/* ------------------------------------------------------------------- frames */

const channel = new BroadcastChannel(CAMERA_CHANNEL);

channel.onmessage = (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'frame') {
    const bitmap = data.bitmap;
    if (canvas.width !== bitmap.width) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close(); // ours to release; the sender closed its own copy
    if (!gotFrame) {
      gotFrame = true;
      fallback.classList.remove('on');
    }
  } else if (data.type === 'camera-error') {
    showFallback(data.message || 'No camera');
  } else if (data.type === 'camera-stopped') {
    gotFrame = false;
  }
};

// If nothing ever arrives, say so rather than showing an empty circle forever.
setTimeout(() => {
  if (!gotFrame) showFallback('No camera');
}, 4000);

/* ------------------------------------------------------------------ controls */

async function start() {
  settings = await loadSettings();
  applyMirror(settings.cameraMirror);
  markSize(settings.cameraSize || 'md');
  showFallback('Connecting…');
}

function applyMirror(on) {
  canvas.classList.toggle('mirror', !!on);
  buttons.mirror.setAttribute('aria-pressed', String(!!on));
}

function markSize(size) {
  for (const key of ['sm', 'md', 'lg']) {
    buttons[key].setAttribute('aria-pressed', String(key === size));
  }
}

for (const size of ['sm', 'md', 'lg']) {
  buttons[size].addEventListener('click', async (event) => {
    event.stopPropagation();
    markSize(size);
    post({ type: 'resize', size });
    settings = await saveSettings({ cameraSize: size });
  });
}

buttons.mirror.addEventListener('click', async (event) => {
  event.stopPropagation();
  const next = !canvas.classList.contains('mirror');
  applyMirror(next);
  settings = await saveSettings({ cameraMirror: next });
});

// Dragging is handed to the parent: pointer capture inside an iframe cannot
// follow the cursor once it leaves the frame's box.
document.body.addEventListener('pointerdown', (event) => {
  if (event.target.closest('button')) return;
  event.preventDefault();
  document.body.classList.add('dragging');
  post({ type: 'drag-start', grabX: event.clientX, grabY: event.clientY });
});

window.addEventListener('pointerup', () => document.body.classList.remove('dragging'));
window.addEventListener('blur', () => document.body.classList.remove('dragging'));
window.addEventListener('pagehide', () => channel.close());

start();
