import { MSG, PHASE, TARGET, isActivePhase } from '../common/messages.js';
import { loadSettings, saveSettings } from '../common/settings.js';
import { availableFormats } from '../common/mime.js';
import { elapsedFrom, formatClock } from '../common/format.js';

const $ = (id) => document.getElementById(id);

const el = {
  setup: $('setup-panel'),
  active: $('active-panel'),
  pill: $('active-pill'),
  pillText: $('active-pill-text'),
  timer: $('active-timer'),
  pause: $('active-pause'),
  stop: $('active-stop'),
  cancel: $('active-cancel'),
  permissionBanner: $('permission-banner'),
  grant: $('grant-btn'),
  errorBanner: $('error-banner'),
  noticeBanner: $('notice-banner'),
  noticeText: $('notice-text'),
  noticeDismiss: $('notice-dismiss'),
  errorText: $('error-text'),
  errorDismiss: $('error-dismiss'),
  useMic: $('use-mic'),
  micDevice: $('mic-device'),
  useCamera: $('use-camera'),
  cameraDevice: $('camera-device'),
  useTabAudio: $('use-tab-audio'),
  quality: $('quality'),
  fps: $('fps'),
  format: $('format'),
  countdown: $('countdown'),
  start: $('start-btn'),
  startLabel: $('start-label'),
  library: $('library-link'),
};

let settings = null;
let ticker = null;

const toWorker = (type, payload = {}) =>
  chrome.runtime.sendMessage({ target: TARGET.WORKER, type, ...payload }).catch(() => undefined);

/* ------------------------------------------------------------------ devices */

async function listDevices() {
  let devices = [];
  try {
    devices = await navigator.mediaDevices.enumerateDevices();
  } catch {
    devices = [];
  }
  fillSelect(
    el.micDevice,
    devices.filter((d) => d.kind === 'audioinput'),
    settings.micDeviceId,
    'Default microphone',
  );
  fillSelect(
    el.cameraDevice,
    devices.filter((d) => d.kind === 'videoinput'),
    settings.cameraDeviceId,
    'Default camera',
  );
}

function fillSelect(select, devices, selectedId, defaultLabel) {
  select.textContent = '';
  // Say so up front when there is nothing to choose from: the recording will now
  // go ahead without it, and finding that out afterwards is a poor way to learn.
  const auto = new Option(devices.length ? defaultLabel : `No ${defaultLabel.split(' ')[1]} detected`, '');
  select.append(auto);
  devices.forEach((device, index) => {
    const label = device.label || `${defaultLabel.split(' ')[1]} ${index + 1}`;
    select.append(new Option(label, device.deviceId));
  });
  select.value = devices.some((d) => d.deviceId === selectedId) ? selectedId : '';
}

/* -------------------------------------------------------------- permissions */

async function permissionStates() {
  const query = async (name) => {
    try {
      return (await navigator.permissions.query({ name })).state;
    } catch {
      return 'prompt';
    }
  };
  const [camera, microphone] = await Promise.all([query('camera'), query('microphone')]);
  return { camera, microphone };
}

async function refreshPermissionBanner() {
  const states = await permissionStates();
  const needMic = el.useMic.checked && states.microphone !== 'granted';
  const needCam = el.useCamera.checked && states.camera !== 'granted';
  const missing = needMic || needCam;
  el.permissionBanner.classList.toggle('hidden', !missing);
  el.start.disabled = missing;
  el.start.title = missing ? 'Grant camera and microphone access first' : '';
}

/* ------------------------------------------------------------------- errors */

async function refreshError() {
  const { lastError, lastNotice } = await chrome.storage.local.get(['lastError', 'lastNotice']);

  el.errorBanner.classList.toggle('hidden', !lastError?.message);
  if (lastError?.message) el.errorText.textContent = lastError.message;

  // A notice means the recording did happen, just not exactly as asked — so it
  // must not look like a failure.
  el.noticeBanner.classList.toggle('hidden', !lastNotice?.message);
  if (lastNotice?.message) el.noticeText.textContent = lastNotice.message;
}

/* -------------------------------------------------------------------- state */

function renderState(state) {
  const active = isActivePhase(state.phase) || state.phase === PHASE.SAVING;
  el.active.classList.toggle('hidden', !active);
  el.setup.classList.toggle('hidden', active);
  if (!active) {
    stopTicker();
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
    return;
  }

  const paused = state.phase === PHASE.PAUSED;
  el.pill.classList.toggle('paused', paused);
  el.pillText.textContent =
    state.phase === PHASE.COUNTDOWN
      ? 'Starting'
      : state.phase === PHASE.SAVING
        ? 'Saving'
        : paused
          ? 'Paused'
          : 'Recording';
  el.pause.textContent = paused ? 'Resume' : 'Pause';
  el.pause.disabled = state.phase === PHASE.COUNTDOWN || state.phase === PHASE.SAVING;
  el.stop.disabled = state.phase === PHASE.SAVING;

  startTicker(state);
}

function startTicker(state) {
  stopTicker();
  const paint = () => {
    el.timer.textContent = formatClock(elapsedFrom(state));
  };
  paint();
  if (state.phase === PHASE.RECORDING) ticker = setInterval(paint, 500);
}

function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

async function syncState() {
  const state = await toWorker(MSG.GET_STATE);
  renderState(state || { phase: PHASE.IDLE });
  return state;
}

/* -------------------------------------------------------------------- wiring */

function bindSetting(input, key, transform = (v) => v) {
  const read = () => (input.type === 'checkbox' ? input.checked : transform(input.value));
  input.addEventListener('change', async () => {
    settings = await saveSettings({ [key]: read() });
    if (input === el.useMic || input === el.useCamera) {
      el.micDevice.disabled = !el.useMic.checked;
      el.cameraDevice.disabled = !el.useCamera.checked;
      await refreshPermissionBanner();
    }
  });
}

function fillFormats() {
  const formats = availableFormats();
  el.format.textContent = '';
  // No codec in the label: an MP4 here is H.264 on machines with an H.264 encoder
  // and VP9 on those without, and claiming one would be wrong half the time.
  const labels = { mp4: 'MP4', webm: 'WebM' };
  for (const ext of formats.length ? formats : ['webm']) {
    el.format.append(new Option(labels[ext] || ext.toUpperCase(), ext));
  }
  el.format.value = formats.includes(settings.format) ? settings.format : el.format.options[0].value;
}

async function init() {
  settings = await loadSettings();

  el.useMic.checked = settings.useMic;
  el.useCamera.checked = settings.useCamera;
  el.useTabAudio.checked = settings.useTabAudio;
  el.quality.value = settings.quality;
  el.fps.value = String(settings.fps);
  el.countdown.value = String(settings.countdownSeconds);
  fillFormats();
  el.micDevice.disabled = !settings.useMic;
  el.cameraDevice.disabled = !settings.useCamera;

  bindSetting(el.useMic, 'useMic');
  bindSetting(el.useCamera, 'useCamera');
  bindSetting(el.useTabAudio, 'useTabAudio');
  bindSetting(el.micDevice, 'micDeviceId');
  bindSetting(el.cameraDevice, 'cameraDeviceId');
  bindSetting(el.quality, 'quality');
  bindSetting(el.fps, 'fps', Number);
  bindSetting(el.format, 'format');
  bindSetting(el.countdown, 'countdownSeconds', Number);

  await listDevices();
  await refreshPermissionBanner();
  await refreshError();
  await syncState();

  el.start.addEventListener('click', async () => {
    el.start.disabled = true;
    el.startLabel.textContent = 'Choose a source…';
    await chrome.storage.local.set({ lastError: null });
    // The source picker steals focus and Chrome closes the popup — that's fine,
    // the worker owns the session from here and surfaces failures via the badge.
    toWorker(MSG.START_RECORDING);
    setTimeout(() => window.close(), 400);
  });

  el.pause.addEventListener('click', async () => {
    const state = await toWorker(MSG.GET_STATE);
    await toWorker(state?.phase === PHASE.PAUSED ? MSG.RESUME : MSG.PAUSE);
    await syncState();
  });

  el.stop.addEventListener('click', async () => {
    await toWorker(MSG.STOP);
    window.close();
  });

  el.cancel.addEventListener('click', async () => {
    await toWorker(MSG.CANCEL);
    await syncState();
  });

  el.grant.addEventListener('click', async () => {
    await toWorker(MSG.OPEN_PERMISSIONS);
    window.close();
  });

  el.library.addEventListener('click', async () => {
    await toWorker(MSG.OPEN_LIBRARY);
    window.close();
  });

  el.noticeDismiss.addEventListener('click', async () => {
    await chrome.storage.local.set({ lastNotice: null });
    el.noticeBanner.classList.add('hidden');
  });

  el.errorDismiss.addEventListener('click', async () => {
    await chrome.storage.local.set({ lastError: null });
    el.errorBanner.classList.add('hidden');
    chrome.action.setBadgeText({ text: '' }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target === TARGET.OVERLAY && message.type === MSG.STATE_CHANGED) {
    renderState(message.state);
  }
  return undefined;
});

window.addEventListener('unload', stopTicker);

init().catch((err) => {
  console.error('[Omnipotent popup]', err);
});
