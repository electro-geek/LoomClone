// One-time camera/microphone grant.
//
// This must be a real tab, never the popup: a popup closes the moment it loses
// focus, which cancels Chrome's permission prompt. Granting here attaches the
// permission to the chrome-extension:// origin, so the offscreen recorder and the
// camera-bubble iframe both inherit it without ever prompting on a recorded page.

const $ = (id) => document.getElementById(id);

const el = {
  micStatus: $('mic-status'),
  camStatus: $('cam-status'),
  micBtn: $('mic-btn'),
  camBtn: $('cam-btn'),
  preview: $('preview'),
  video: $('preview-video'),
  level: $('level'),
  done: $('done-btn'),
  revoke: $('revoke-help'),
};

let previewStream = null;
let audioContext = null;
let levelRaf = null;

async function queryState(name) {
  try {
    return (await navigator.permissions.query({ name })).state;
  } catch {
    return 'prompt';
  }
}

function paint(node, state, button) {
  node.classList.remove('granted', 'denied');
  // Once granted, the chip says everything — a dead "Allowed" button next to it
  // is just noise, so it goes away.
  button.hidden = state === 'granted';
  if (state === 'granted') {
    node.textContent = 'Allowed';
    node.classList.add('granted');
  } else if (state === 'denied') {
    node.textContent = 'Blocked';
    node.classList.add('denied');
    button.disabled = false;
    button.textContent = 'Retry';
  } else {
    node.textContent = 'Not set';
    button.disabled = false;
    button.textContent = 'Allow';
  }
}

async function refresh() {
  const [mic, cam] = await Promise.all([queryState('microphone'), queryState('camera')]);
  paint(el.micStatus, mic, el.micBtn);
  paint(el.camStatus, cam, el.camBtn);
  await chrome.storage.local.set({
    devicePermissions: { microphone: mic, camera: cam, checkedAt: Date.now() },
  });
  if (mic === 'granted' || cam === 'granted') {
    await startPreview({ audio: mic === 'granted', video: cam === 'granted' });
  }
}

async function request(constraints) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream.getTracks().forEach((track) => track.stop());
  } catch (err) {
    console.warn('[Omnipotent permissions]', err?.name, err?.message);
  }
  await refresh();
}

async function startPreview({ audio, video }) {
  stopPreview();
  if (!audio && !video) return;
  try {
    previewStream = await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch {
    return;
  }
  el.preview.classList.add('on');
  if (video) el.video.srcObject = previewStream;
  else el.video.style.display = 'none';

  if (audio && previewStream.getAudioTracks().length) {
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(previewStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (const value of data) peak = Math.max(peak, Math.abs(value - 128));
      el.level.style.width = `${Math.min(100, (peak / 90) * 100)}%`;
      levelRaf = requestAnimationFrame(tick);
    };
    tick();
  }
}

function stopPreview() {
  if (levelRaf) cancelAnimationFrame(levelRaf);
  levelRaf = null;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
  previewStream?.getTracks().forEach((track) => track.stop());
  previewStream = null;
  el.video.srcObject = null;
  el.preview.classList.remove('on');
}

el.micBtn.addEventListener('click', () => request({ audio: true }));
el.camBtn.addEventListener('click', () => request({ video: true }));

el.done.addEventListener('click', () => {
  stopPreview();
  window.close();
});

el.revoke.addEventListener('click', () => {
  // chrome:// URLs cannot be opened by an extension, so show the path instead.
  el.revoke.textContent = 'Copied the settings path below';
  document.getElementById('note').scrollIntoView({ behavior: 'smooth', block: 'center' });
});

window.addEventListener('pagehide', stopPreview);

refresh();
