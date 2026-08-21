// The recorder itself. Lives in an offscreen document so capture survives tab
// navigation, tab switching and the service worker being torn down.

import { CAMERA_CHANNEL, MSG, TARGET, sendSafe } from '../common/messages.js';
import { pickMimeType } from '../common/mime.js';
import {
  appendChunk,
  assembleBlob,
  commitRecording,
  deleteChunks,
  requestPersistence,
} from '../common/db.js';

const CHUNK_MS = 1000; // one IndexedDB row per second keeps memory flat
const HEARTBEAT_MS = 20_000;
const CAMERA_FPS = 24;
const CAMERA_SIZE = 300; // square frame, comfortably above the largest bubble

/** @type {null | ReturnType<typeof blankSession>} */
let session = null;
let heartbeat = null;

function blankSession() {
  return {
    recordingId: null,
    micDropped: null,
    settings: null,
    screenStream: null,
    micStream: null,
    audioContext: null,
    recordStream: null,
    recorder: null,
    mimeType: '',
    ext: 'webm',
    seq: 0,
    writeChain: Promise.resolve(),
    startedAt: null,
    pausedAt: null,
    pausedTotalMs: 0,
    discard: false,
    stopped: false,
    audioDropped: false,
    cameraStream: null,
    cameraChannel: null,
    cameraTimer: null,
    hasMic: false,
    hasTabAudio: false,
    width: null,
    height: null,
  };
}

/* ------------------------------------------------------------------ capture */

async function prepare({ recordingId, settings, quality }) {
  await teardown(); // never stack two sessions
  session = blankSession();
  session.recordingId = recordingId;
  session.settings = settings;

  // The worker is awaiting this call while the user reads the picker, and MV3
  // evicts an idle worker after ~30s. Choosing a source easily takes longer than
  // that, and an evicted worker never resumes its half-finished start — so beat
  // from here, not from BEGIN, to keep it alive for as long as the picker is up.
  startHeartbeat();

  // 1. Screen/window/tab video (+ optional tab or system audio).
  //
  //    getDisplayMedia is called here, in the same document that will consume the
  //    stream, because a capture stream is bound to the frame that requested it.
  //    Offscreen documents are allowed to call it without a user gesture — that is
  //    exactly what the DISPLAY_MEDIA creation reason is for — so the picker can be
  //    driven from the extension rather than from a page that might close.
  const video = { frameRate: { ideal: settings.fps || 30 } };
  if (quality.maxWidth) {
    video.width = { max: quality.maxWidth };
    video.height = { max: quality.maxHeight };
  }

  const wantTabAudio = !!settings.useTabAudio;

  function displayConstraints(withAudio) {
    return {
      video,
      // Chrome shows its "Also share tab audio" checkbox only when audio is asked
      // for. If the user leaves it unticked we simply get no audio track back.
      audio: withAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
      systemAudio: withAudio ? 'include' : 'exclude',
      surfaceSwitching: 'include', // let the user switch the shared tab mid-recording
      selfBrowserSurface: 'exclude',
      monitorTypeSurfaces: 'include',
    };
  }

  let audioDropped = false;
  const askedAt = performance.now();
  try {
    session.screenStream = await navigator.mediaDevices.getDisplayMedia(
      displayConstraints(wantTabAudio),
    );
  } catch (err) {
    const elapsed = performance.now() - askedAt;
    console.warn(
      `[Omnipotent] getDisplayMedia failed after ${Math.round(elapsed)}ms:`,
      err?.name,
      err?.message,
    );

    // Asking for system audio can sink the whole request on platforms whose
    // capture backend cannot supply it — notably Linux/Wayland via the desktop
    // portal. Losing the audio is far better than losing the recording, so try
    // once more for video alone.
    if (wantTabAudio && !isUserCancel(err)) {
      try {
        session.screenStream = await navigator.mediaDevices.getDisplayMedia(
          displayConstraints(false),
        );
        audioDropped = true;
        console.warn('[Omnipotent] captured without tab audio — the system refused it');
      } catch (retryErr) {
        await teardown();
        return failedCapture(retryErr, performance.now() - askedAt);
      }
    } else {
      await teardown();
      return failedCapture(err, elapsed);
    }
  }

  session.audioDropped = audioDropped;

  session.hasTabAudio = session.screenStream.getAudioTracks().length > 0;

  const videoTrack = session.screenStream.getVideoTracks()[0];
  if (!videoTrack) {
    await teardown();
    return { ok: false, error: 'The selected source produced no video.' };
  }
  const trackSettings = videoTrack.getSettings?.() || {};
  session.width = trackSettings.width ?? null;
  session.height = trackSettings.height ?? null;

  // Chrome's own "Stop sharing" bar ends the track behind our back.
  // (Also fires if the captured window or tab is closed.)
  videoTrack.addEventListener('ended', () => {
    if (session && !session.stopped) sendSafe({ target: TARGET.WORKER, type: MSG.SOURCE_ENDED });
  });

  // 2. Microphone.
  //
  //    A mic that will not open used to end the whole session — the picker had
  //    already been answered, the screen was ready, and the recording died anyway
  //    over the one input the user can least afford to lose the screen for. It is
  //    a downgrade, not a failure: keep the pixels, say what went missing.
  let micDropped = null;
  if (settings.useMic) {
    try {
      session.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: settings.micDeviceId ? { exact: settings.micDeviceId } : undefined,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      session.hasMic = session.micStream.getAudioTracks().length > 0;
    } catch (err) {
      console.warn('[Omnipotent] microphone unavailable:', err?.name, err?.message);
      // A device that was picked by id and has since gone is worth one retry on
      // whatever else is there; the pinned id is a preference, not a requirement.
      if (settings.micDeviceId) {
        try {
          session.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
          session.hasMic = session.micStream.getAudioTracks().length > 0;
        } catch (retryErr) {
          micDropped = micReason(retryErr);
        }
      } else {
        micDropped = micReason(err);
      }
    }
  }
  session.micDropped = micDropped;

  // 3. Webcam frames for the in-page bubble.
  await startCameraFeed(settings);

  // 4. One audio track for the recorder. Two sources need a WebAudio mix; a single
  //    source is passed straight through, which avoids depending on an AudioContext
  //    being allowed to start in a document that never saw a user gesture.
  const screenAudio = session.screenStream.getAudioTracks();
  const micAudio = session.micStream ? session.micStream.getAudioTracks() : [];
  let audioTracks = [];

  if (screenAudio.length && micAudio.length) {
    const ctx = new AudioContext();
    session.audioContext = ctx;
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(new MediaStream(screenAudio)).connect(dest);
    ctx.createMediaStreamSource(new MediaStream(micAudio)).connect(dest);
    if (ctx.state === 'running') {
      audioTracks = dest.stream.getAudioTracks();
    } else {
      // Mixer never started — keep the narration rather than recording silence.
      console.warn('[Omnipotent] AudioContext suspended; falling back to mic only');
      audioTracks = micAudio;
      await ctx.close().catch(() => {});
      session.audioContext = null;
    }
  } else if (micAudio.length) {
    audioTracks = micAudio;
  } else if (screenAudio.length) {
    audioTracks = screenAudio;
  }

  session.recordStream = new MediaStream([videoTrack, ...audioTracks]);

  // 5. Recorder.
  const format = pickMimeType(settings.format);
  session.mimeType = format.mimeType;
  session.ext = format.ext;
  try {
    session.recorder = new MediaRecorder(session.recordStream, {
      ...(format.mimeType ? { mimeType: format.mimeType } : {}),
      videoBitsPerSecond: quality.videoBitsPerSecond,
      audioBitsPerSecond: 128_000,
    });
  } catch (err) {
    await teardown();
    return { ok: false, error: describe(err, 'This Chrome build cannot record that format.') };
  }

  // MediaRecorder may pick a different container than requested.
  if (session.recorder.mimeType) {
    session.mimeType = session.recorder.mimeType;
    session.ext = session.recorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
  }

  session.recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0 || !session) return;
    const seq = session.seq++;
    const id = session.recordingId;
    session.writeChain = session.writeChain
      .then(() => appendChunk(id, seq, event.data))
      .catch((err) => console.error('[Omnipotent] chunk write failed', err));
  };
  session.recorder.onerror = (event) => {
    const error = describe(event?.error, 'Recorder error.');
    sendSafe({ target: TARGET.WORKER, type: MSG.RECORDING_FAILED, error });
  };
  session.recorder.onstop = () => {
    finalize().catch((err) => {
      sendSafe({
        target: TARGET.WORKER,
        type: MSG.RECORDING_FAILED,
        error: describe(err, 'Could not save the recording.'),
      });
    });
  };

  await requestPersistence().catch(() => {});
  return {
    ok: true,
    mimeType: session.mimeType,
    ext: session.ext,
    audioDropped: session.audioDropped === true,
    micDropped: session.micDropped || null,
  };
}

/**
 * What is actually happening in here?
 *
 * The worker's stored phase is only a record of what it last intended; if it was
 * evicted mid-start, that phase outlives the task that set it. This is the ground
 * truth it checks against before refusing a new recording.
 */
function status() {
  return {
    ok: true,
    hasSession: !!session,
    hasStream: !!session?.screenStream,
    recorderState: session?.recorder?.state || 'none',
  };
}

function begin() {
  if (!session?.recorder) return { ok: false, error: 'Recorder is not ready.' };
  if (session.recorder.state !== 'inactive') return { ok: true };
  session.recorder.start(CHUNK_MS);
  session.startedAt = Date.now();
  startHeartbeat();
  return { ok: true };
}

function pause() {
  if (session?.recorder?.state !== 'recording') return { ok: false };
  session.recorder.pause();
  session.pausedAt = Date.now();
  return { ok: true };
}

function resume() {
  if (session?.recorder?.state !== 'paused') return { ok: false };
  session.recorder.resume();
  session.pausedTotalMs += Date.now() - (session.pausedAt || Date.now());
  session.pausedAt = null;
  return { ok: true };
}

function setMuted(muted) {
  if (!session?.micStream) return { ok: false };
  for (const track of session.micStream.getAudioTracks()) track.enabled = !muted;
  return { ok: true };
}

function stop({ discard = false } = {}) {
  if (!session) return { ok: false };
  session.discard = discard;
  stopHeartbeat();
  if (session.recorder && session.recorder.state !== 'inactive') {
    session.stopped = true;
    session.recorder.stop(); // flushes a final dataavailable, then fires onstop
  } else {
    finalize().catch(() => {});
  }
  return { ok: true };
}

/* ------------------------------------------------------------ camera feed */

/**
 * Open the webcam here and broadcast frames to the in-page bubble.
 *
 * The bubble used to call getUserMedia itself, from an iframe inside the page.
 * That breaks on any site serving `Permissions-Policy: camera=()`, because the
 * policy is inherited by every frame the page contains and a subframe cannot
 * re-enable what the top document switched off. Capturing here instead sidesteps
 * it entirely: this document is top-level and owned by the extension, so the
 * bubble only ever paints pixels and needs no camera permission of its own.
 */
async function startCameraFeed(settings) {
  if (!settings.useCamera || !session) return;

  try {
    session.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: settings.cameraDeviceId ? { exact: settings.cameraDeviceId } : undefined,
        width: { ideal: 640 },
        height: { ideal: 640 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (err) {
    console.warn('[Omnipotent] camera unavailable:', err?.name, err?.message);
    new BroadcastChannel(CAMERA_CHANNEL).postMessage({
      type: 'camera-error',
      message: describe(err, 'The webcam could not be opened.'),
    });
    sendSafe({
      target: TARGET.WORKER,
      type: MSG.CAMERA_BLOCKED,
      blockedByPage: false,
      detail: `${err?.name || 'Error'}: ${err?.message || ''}`,
    });
    return;
  }

  const video = document.getElementById('camera-feed');
  video.srcObject = session.cameraStream;
  await video.play().catch(() => {});

  session.cameraChannel = new BroadcastChannel(CAMERA_CHANNEL);
  let sending = false;

  session.cameraTimer = setInterval(async () => {
    if (sending || !session?.cameraChannel) return;
    if (!video.videoWidth || !video.videoHeight) return;
    sending = true;
    try {
      // Centre-crop to a square so the round bubble never distorts.
      const side = Math.min(video.videoWidth, video.videoHeight);
      const sx = (video.videoWidth - side) / 2;
      const sy = (video.videoHeight - side) / 2;
      const bitmap = await createImageBitmap(video, sx, sy, side, side, {
        resizeWidth: CAMERA_SIZE,
        resizeHeight: CAMERA_SIZE,
        resizeQuality: 'medium',
      });
      session.cameraChannel.postMessage({ type: 'frame', bitmap });
      bitmap.close(); // the receiver gets its own clone
    } catch {
      /* a dropped frame is not worth reporting */
    } finally {
      sending = false;
    }
  }, Math.round(1000 / CAMERA_FPS));
}

function stopCameraFeed(sess) {
  if (!sess) return;
  if (sess.cameraTimer) clearInterval(sess.cameraTimer);
  sess.cameraTimer = null;
  sess.cameraStream?.getTracks().forEach((track) => track.stop());
  sess.cameraStream = null;
  const video = document.getElementById('camera-feed');
  if (video) video.srcObject = null;
  if (sess.cameraChannel) {
    sess.cameraChannel.postMessage({ type: 'camera-stopped' });
    sess.cameraChannel.close();
    sess.cameraChannel = null;
  }
}

/* ----------------------------------------------------------------- finalize */

async function finalize() {
  if (!session) return;
  const {
    recordingId,
    mimeType,
    ext,
    discard,
    startedAt,
    pausedTotalMs,
    pausedAt,
    settings,
    hasMic,
    hasTabAudio,
    width,
    height,
  } = session;

  await session.writeChain.catch(() => {});

  if (discard) {
    await deleteChunks(recordingId).catch(() => {});
    await teardown();
    return;
  }

  const endedAt = Date.now();
  const pausedTotal = pausedTotalMs + (pausedAt ? endedAt - pausedAt : 0);
  const durationMs = startedAt ? Math.max(0, endedAt - startedAt - pausedTotal) : 0;

  const blob = await assembleBlob(recordingId, mimeType);
  if (!blob || blob.size === 0) {
    await deleteChunks(recordingId).catch(() => {});
    await teardown();
    sendSafe({
      target: TARGET.WORKER,
      type: MSG.RECORDING_FAILED,
      error: 'Nothing was captured — the recording was empty.',
    });
    return;
  }

  const thumbnail = await makeThumbnail(blob, durationMs).catch(() => null);

  const meta = await commitRecording(recordingId, blob, {
    title: defaultTitle(),
    createdAt: startedAt || endedAt,
    durationMs,
    mimeType,
    ext,
    width,
    height,
    hasMic,
    hasCamera: !!settings?.useCamera,
    hasTabAudio,
    thumbnail,
  });

  await teardown();
  sendSafe({ target: TARGET.WORKER, type: MSG.RECORDING_SAVED, meta });
}

function defaultTitle() {
  const now = new Date();
  const date = now.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Recording — ${date}, ${time}`;
}

/** Grab a poster frame. Never allowed to block or fail a save. */
function makeThumbnail(blob, durationMs) {
  return new Promise((resolve) => {
    const video = document.getElementById('thumb-probe');
    const url = URL.createObjectURL(blob);
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), 5000);

    video.onloadeddata = () => {
      const target = Math.min(1, Math.max(0, durationMs / 1000 / 2));
      try {
        video.currentTime = target;
      } catch {
        draw();
      }
    };
    video.onseeked = () => draw();
    video.onerror = () => finish(null);

    function draw() {
      try {
        const width = 480;
        const ratio = video.videoWidth ? video.videoHeight / video.videoWidth : 9 / 16;
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = Math.round(width * ratio);
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.6));
      } catch {
        finish(null);
      }
    }

    video.src = url;
  });
}

/* ------------------------------------------------------------------ helpers */

async function teardown() {
  stopHeartbeat();
  if (!session) return;
  stopCameraFeed(session);
  const { screenStream, micStream, audioContext, recorder } = session;
  try {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  } catch {
    /* already stopped */
  }
  for (const stream of [screenStream, micStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }
  if (audioContext) await audioContext.close().catch(() => {});
  session = null;
}

function startHeartbeat() {
  stopHeartbeat();
  // Inbound messages reset the service worker's idle timer, so it stays alive to
  // coordinate. Recording continues here either way.
  heartbeat = setInterval(() => {
    sendSafe({ target: TARGET.WORKER, type: MSG.HEARTBEAT });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

/**
 * Did the human dismiss the picker, or did the request die on its own?
 *
 * Chrome reports both as NotAllowedError, so the name alone cannot tell them
 * apart. This used to be decided by timing — anything slower than 400ms was
 * called a cancel — which was wrong in the one case that mattered: the elapsed
 * time includes however long the picker sat open, so a backend that failed
 * *after* the user pressed Share always looked like a deliberate cancel and
 * disappeared without a banner, a badge or a log line.
 *
 * Chrome does say which it was, in words, so read those instead:
 *   "Permission denied by user"   — the picker was dismissed
 *   "Permission denied by system" — the OS or portal refused it
 *   "Permission denied"           — genuinely ambiguous
 * Anything ambiguous is reported as a notice rather than assumed away.
 */
function classifyDenial(err) {
  const message = String(err?.message || '');
  if (/\bby system\b|not supported|failed to (start|access|capture)/i.test(message)) return 'system';
  if (/\bby user\b|user denied|dismissed|cancell?ed|request is not allowed by the user agent/i.test(message)) {
    return 'cancel';
  }
  return 'unknown';
}

function isUserCancel(err) {
  return err?.name === 'NotAllowedError' && classifyDenial(err) === 'cancel';
}

/** Exactly what Chrome said, kept verbatim so a failure can always be traced. */
function rawDetail(err, elapsedMs) {
  return `${err?.name || 'Error'}: ${err?.message || 'no message'} (after ${Math.round(elapsedMs)}ms)`;
}

/** Turn a display-capture failure into something the user can act on. */
function failedCapture(err, elapsedMs) {
  const name = err?.name || '';
  const detail = rawDetail(err, elapsedMs);
  const linux = navigator.userAgent.includes('Linux');

  if (name === 'NotAllowedError') {
    const kind = classifyDenial(err);
    if (kind === 'cancel') return { ok: false, cancelled: true, detail };
    if (kind === 'unknown') {
      // Might have been a cancel, might have been the capture backend giving up.
      // Going back to idle is right either way; going back in silence is not, so
      // the session ends without an alarm but leaves the reason behind.
      return { ok: false, cancelled: true, uncertain: true, detail };
    }
    return {
      ok: false,
      error: linux
        ? `The system refused screen capture. On Wayland this is usually the desktop portal — check that xdg-desktop-portal is running, or start Chrome with --enable-features=WebRTCPipeWireCapturer. [${detail}]`
        : `The system refused screen capture. Check Chrome and OS screen-recording permissions. [${detail}]`,
    };
  }
  if (name === 'NotFoundError') {
    return { ok: false, error: `No screen, window or tab was available to capture. [${detail}]` };
  }
  if (name === 'NotReadableError') {
    return { ok: false, error: `Another application is already capturing the screen. [${detail}]` };
  }
  if (name === 'OverconstrainedError') {
    return {
      ok: false,
      error: `The source could not deliver the requested quality (${err?.constraint || 'unknown constraint'}). Try Native quality. [${detail}]`,
    };
  }
  if (name === 'InvalidStateError') {
    return {
      ok: false,
      error: `Chrome refused the capture request (invalid state). Reload the extension and try again. [${detail}]`,
    };
  }
  if (name === 'AbortError') {
    return { ok: false, error: `Screen capture was aborted before it delivered a stream. [${detail}]` };
  }
  return { ok: false, error: `${describe(err, 'Could not start screen capture.')} [${detail}]` };
}

/** Why the microphone did not open, in terms the user can act on. */
function micReason(err) {
  const name = err?.name || '';
  if (name === 'NotFoundError') {
    return navigator.userAgent.includes('Linux')
      ? 'Chrome cannot see any microphone. This usually means Chrome outlived a restart of the system audio server — quit Chrome completely and reopen it.'
      : 'Chrome cannot see any microphone.';
  }
  if (name === 'NotAllowedError') {
    return 'Microphone access is not granted. Open the Omnipotent permission page and allow it.';
  }
  if (name === 'NotReadableError') return 'The microphone is already in use by another app.';
  return describe(err, 'The microphone could not be opened.');
}

function describe(err, fallback) {
  if (!err) return fallback;
  const name = err.name || '';
  if (name === 'NotAllowedError') {
    return 'Permission denied. Open the Omnipotent permission page and allow camera + microphone.';
  }
  if (name === 'NotFoundError') return 'No matching device was found.';
  if (name === 'NotReadableError') return 'The device is already in use by another app.';
  return err.message ? `${err.message}` : fallback;
}

/* ------------------------------------------------------------------ routing */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET.OFFSCREEN) return undefined;

  (async () => {
    switch (message.type) {
      case MSG.PREPARE:
        sendResponse(await prepare(message));
        break;
      case MSG.BEGIN:
        sendResponse(begin());
        break;
      case MSG.OFFSCREEN_PAUSE:
        sendResponse(pause());
        break;
      case MSG.OFFSCREEN_RESUME:
        sendResponse(resume());
        break;
      case MSG.OFFSCREEN_MUTE:
        sendResponse(setMuted(!!message.muted));
        break;
      case MSG.OFFSCREEN_STOP:
        sendResponse(stop({ discard: false }));
        break;
      case MSG.OFFSCREEN_CANCEL:
        sendResponse(stop({ discard: true }));
        break;
      case MSG.OFFSCREEN_STATUS:
        sendResponse(status());
        break;
      default:
        sendResponse({ ok: false, error: `Unknown message ${message.type}` });
    }
  })().catch((err) => sendResponse({ ok: false, error: describe(err, 'Recorder error.') }));

  return true;
});
