// User settings, persisted in chrome.storage.local so they survive restarts and
// are readable from every context (popup, worker, offscreen, overlay iframes).

const KEY = 'settings';

export const QUALITY = {
  '720p': { maxWidth: 1280, maxHeight: 720, videoBitsPerSecond: 2_500_000, label: '720p' },
  '1080p': { maxWidth: 1920, maxHeight: 1080, videoBitsPerSecond: 5_000_000, label: '1080p' },
  native: { maxWidth: null, maxHeight: null, videoBitsPerSecond: 8_000_000, label: 'Native' },
};

export const DEFAULTS = {
  useMic: true,
  useCamera: true,
  useTabAudio: false,
  micDeviceId: '',
  cameraDeviceId: '',
  quality: '1080p',
  fps: 30,
  format: 'mp4',
  countdownSeconds: 3,
  // Camera bubble presentation, shared between popup and the overlay iframe.
  cameraSize: 'md', // sm | md | lg
  cameraMirror: true,
  cameraPosition: null, // {left, top} in px, set by dragging
  controlsPosition: null,
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(stored[KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export function qualityFor(settings) {
  return QUALITY[settings.quality] || QUALITY['1080p'];
}
