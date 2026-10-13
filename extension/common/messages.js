// Message contract shared by every context (popup, service worker, offscreen,
// content script, overlay iframes).
//
// Routing rule: every message carries a `target`. A context ignores anything not
// addressed to it, because chrome.runtime.sendMessage fans out to ALL extension
// contexts at once.

/**
 * Camera frames travel over a BroadcastChannel rather than chrome.runtime
 * messaging, which only carries JSON-ish values and would flatten an
 * ImageBitmap. Every extension page shares one origin, so the channel reaches
 * the offscreen document and every bubble at once.
 */
export const CAMERA_CHANNEL = 'omnipotent-camera';

export const TARGET = {
  WORKER: 'worker',
  OFFSCREEN: 'offscreen',
  OVERLAY: 'overlay',
};

export const MSG = {
  // popup -> worker
  START_RECORDING: 'start-recording',
  GET_STATE: 'get-state',
  OPEN_LIBRARY: 'open-library',
  OPEN_PERMISSIONS: 'open-permissions',

  // overlay / controls -> worker
  COUNTDOWN_DONE: 'countdown-done',
  PAUSE: 'pause',
  RESUME: 'resume',
  STOP: 'stop',
  CANCEL: 'cancel',
  SET_MIC_MUTED: 'set-mic-muted',

  // worker -> offscreen
  PREPARE: 'prepare',
  BEGIN: 'begin',
  OFFSCREEN_PAUSE: 'offscreen-pause',
  OFFSCREEN_RESUME: 'offscreen-resume',
  OFFSCREEN_STOP: 'offscreen-stop',
  OFFSCREEN_CANCEL: 'offscreen-cancel',
  OFFSCREEN_MUTE: 'offscreen-mute',
  OFFSCREEN_STATUS: 'offscreen-status',

  // camera bubble -> worker
  CAMERA_BLOCKED: 'camera-blocked',

  // offscreen -> worker
  HEARTBEAT: 'heartbeat',
  RECORDING_SAVED: 'recording-saved',
  RECORDING_FAILED: 'recording-failed',
  SOURCE_ENDED: 'source-ended',

  // worker -> overlay (broadcast)
  STATE_CHANGED: 'state-changed',
  START_COUNTDOWN: 'start-countdown',
  TEARDOWN_OVERLAY: 'teardown-overlay',
};

export const PHASE = {
  IDLE: 'idle',
  STARTING: 'starting',
  COUNTDOWN: 'countdown',
  RECORDING: 'recording',
  PAUSED: 'paused',
  SAVING: 'saving',
};

/** True while a recording session owns the UI (overlay should be mounted). */
export function isActivePhase(phase) {
  return (
    phase === PHASE.COUNTDOWN ||
    phase === PHASE.RECORDING ||
    phase === PHASE.PAUSED
  );
}

/**
 * chrome.runtime.sendMessage that never throws when nothing is listening.
 * "Receiving end does not exist" is routine here — overlays come and go with tabs.
 */
export async function sendSafe(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch {
    return undefined;
  }
}
