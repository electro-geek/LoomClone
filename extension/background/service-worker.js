// Coordinator for the whole recording session.
//
// The worker never touches a MediaStream — MV3 workers have no DOM. It drives the
// native source picker, owns the offscreen document that does the actual recording,
// keeps the in-page overlay following the user from tab to tab, and stores session
// state in chrome.storage.session so everything survives the worker being killed
// mid-recording (the offscreen document keeps recording regardless).

import { MSG, PHASE, TARGET, isActivePhase, sendSafe } from '../common/messages.js';
import { loadSettings, qualityFor } from '../common/settings.js';
import {
  deleteChunks,
  migrateLegacyRecordings,
  newRecordingId,
  orphanChunkIds,
  requestPersistence,
} from '../common/db.js';

const STATE_KEY = 'session';
const OFFSCREEN_PATH = 'offscreen/offscreen.html';

// A start that gets interrupted must not outlive the task that began it, so the
// transient phases carry a clock the next attempt can judge them by.
const STALE_PICKER_MS = 120_000; // a picker nobody has answered in two minutes
const STALE_COUNTDOWN_MS = 15_000; // the longest countdown is 5s

const IDLE_STATE = {
  phase: PHASE.IDLE,
  phaseAt: null,
  recordingId: null,
  startedAt: null,
  pausedTotalMs: 0,
  pausedAt: null,
  micMuted: false,
  options: null,
  injectedTabIds: [],
};

/* ------------------------------------------------------------------- state */

async function getState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return { ...IDLE_STATE, ...(stored[STATE_KEY] || {}) };
}

async function setState(patch) {
  const prev = await getState();
  const next = { ...prev, ...patch };
  if (patch.phase && patch.phase !== prev.phase) next.phaseAt = Date.now();
  await chrome.storage.session.set({ [STATE_KEY]: next });
  await paintBadge(next);
  return next;
}

async function resetState() {
  await chrome.storage.session.set({ [STATE_KEY]: { ...IDLE_STATE } });
  await paintBadge(IDLE_STATE);
}

async function paintBadge(state) {
  const map = {
    // Brand palette: signal red means recording, sage means anything else.
    [PHASE.RECORDING]: { text: 'REC', color: '#c0392b' },
    [PHASE.STARTING]: { text: '...', color: '#6e7566' },
    [PHASE.PAUSED]: { text: 'II', color: '#6e7566' },
    [PHASE.COUNTDOWN]: { text: '...', color: '#6e7566' },
    [PHASE.SAVING]: { text: '...', color: '#6e7566' },
  };
  const badge = map[state.phase];
  try {
    await chrome.action.setBadgeText({ text: badge ? badge.text : '' });
    if (badge) await chrome.action.setBadgeBackgroundColor({ color: badge.color });
  } catch {
    /* action API unavailable during shutdown */
  }
}

async function setLastError(message) {
  await chrome.storage.local.set({
    lastError: message ? { message, at: Date.now() } : null,
  });
}

/** A non-fatal heads-up: the recording started, but not exactly as asked. */
async function setNotice(message) {
  await chrome.storage.local.set({
    lastNotice: message ? { message, at: Date.now() } : null,
  });
}

/* -------------------------------------------------------- offscreen document */

let offscreenCreating = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (offscreenCreating) return offscreenCreating;
  offscreenCreating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['USER_MEDIA', 'DISPLAY_MEDIA'],
      justification: 'Captures the selected screen, microphone and tab audio.',
    })
    .finally(() => {
      offscreenCreating = null;
    });
  return offscreenCreating;
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch {
    /* already gone */
  }
}

function toOffscreen(type, payload = {}) {
  return sendSafe({ target: TARGET.OFFSCREEN, type, ...payload });
}

/* ------------------------------------------------------------------ overlay */

const INJECTABLE = /^(https?|file):/;

function isInjectable(tab) {
  if (!tab || !tab.id || tab.id === chrome.tabs.TAB_ID_NONE) return false;
  if (!tab.url || !INJECTABLE.test(tab.url)) return false;
  // Chrome blocks script injection on its own Web Store.
  if (/^https:\/\/chromewebstore\.google\.com/.test(tab.url)) return false;
  if (/^https:\/\/chrome\.google\.com\/webstore/.test(tab.url)) return false;
  return true;
}

/**
 * The tab the overlay should live in.
 *
 * Focus is in flux at the one moment this is called: the picker has just closed,
 * and answering it with "entire screen" or another application's window hands
 * focus away from Chrome entirely — so `lastFocusedWindow` can match no window at
 * all, or match one whose active tab is a chrome:// page. A single query there
 * silently cost the user the whole overlay: no countdown, no camera bubble and no
 * control bar. Widen the net, and prefer a tab the overlay can actually mount in.
 */
async function activeTab() {
  const queries = [
    { active: true, lastFocusedWindow: true },
    { active: true, currentWindow: true },
    { active: true, windowType: 'normal' },
  ];
  const fallbacks = [];
  for (const query of queries) {
    const tabs = await chrome.tabs.query(query).catch(() => []);
    for (const tab of tabs) {
      if (isInjectable(tab)) return tab;
      fallbacks.push(tab);
    }
  }
  return fallbacks[0] || null;
}

function toTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

/**
 * Make sure the overlay is mounted in `tab` and knows the current state.
 * Returns true when the overlay is live in that tab.
 */
async function mountOverlay(tab, state) {
  if (!isInjectable(tab)) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/overlay.js'],
    });
  } catch {
    return false; // restricted page, tab closed mid-flight, etc.
  }
  if (!state.injectedTabIds.includes(tab.id)) {
    state.injectedTabIds = [...state.injectedTabIds, tab.id];
    await setState({ injectedTabIds: state.injectedTabIds });
  }
  await toTab(tab.id, {
    target: TARGET.OVERLAY,
    type: MSG.STATE_CHANGED,
    state: publicState(state),
  });
  return true;
}

async function unmountOverlays(state) {
  await Promise.all(
    state.injectedTabIds.map((tabId) =>
      toTab(tabId, { target: TARGET.OVERLAY, type: MSG.TEARDOWN_OVERLAY }),
    ),
  );
  await setState({ injectedTabIds: [] });
}

/** Name the page in front the way the user would recognise it. */
function describeSurface(tab) {
  const url = tab?.url || '';
  if (!tab) return 'The page you started from';
  if (/^chrome:\/\/(newtab|new-tab-page)|^chrome-search:/.test(url)) return 'The New Tab page';
  if (/^https:\/\/chromewebstore\.google\.com|^https:\/\/chrome\.google\.com\/webstore/.test(url)) {
    return 'The Chrome Web Store';
  }
  if (/^chrome:\/\//.test(url)) return `Chrome's own ${url.replace(/^chrome:\/\//, '').split('/')[0]} page`;
  if (/^chrome-extension:\/\//.test(url)) return 'An extension page';
  if (/\.pdf(\?|$)/i.test(url)) return "Chrome's PDF viewer";
  return 'The page you started from';
}

/** State shape handed to overlays, the popup and the control bar. */
function publicState(state) {
  return {
    phase: state.phase,
    startedAt: state.startedAt,
    pausedTotalMs: state.pausedTotalMs,
    pausedAt: state.pausedAt,
    micMuted: state.micMuted,
    options: state.options,
  };
}

async function broadcast(state) {
  const message = {
    target: TARGET.OVERLAY,
    type: MSG.STATE_CHANGED,
    state: publicState(state),
  };
  await sendSafe(message); // extension pages: overlay iframes, popup, library
  await Promise.all(state.injectedTabIds.map((tabId) => toTab(tabId, message)));
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Is the stored session still owned by anything, or is it a leftover?
 *
 * A phase is only ever a record of what this worker last *intended*. STARTING and
 * COUNTDOWN are set mid-task and cleared by the rest of that same task — so if the
 * worker is evicted while the picker is open (MV3 does that after ~30s idle), or
 * the offscreen document dies, the phase outlives the task and the guard below
 * refuses every later attempt forever. The recorder itself is the ground truth.
 */
async function sessionIsDead(state) {
  if (!(await hasOffscreen())) return true; // nothing is recording anything

  const status = await toOffscreen(MSG.OFFSCREEN_STATUS);
  if (!status?.ok) return true; // document is there but not answering

  // Genuinely capturing: leave it well alone.
  if (status.recorderState === 'recording' || status.recorderState === 'paused') return false;

  const age = Date.now() - (state.phaseAt || 0);

  if (state.phase === PHASE.STARTING) {
    // A session with no stream yet means the picker is still on screen. That is a
    // live start until it has been up long enough that nobody is coming back.
    if (status.hasSession && !status.hasStream) return age > STALE_PICKER_MS;
    return true; // prepared, but nobody ever sent BEGIN — the start was orphaned
  }
  if (state.phase === PHASE.COUNTDOWN) return age > STALE_COUNTDOWN_MS;
  return !status.hasSession; // SAVING with nothing left to save
}

async function startRecording() {
  const current = await getState();
  if (current.phase !== PHASE.IDLE) {
    if (await sessionIsDead(current)) {
      console.warn(`[Omnipotent] reclaiming an abandoned "${current.phase}" session`);
      await abortSession();
    } else {
      // Never refuse in silence: the popup throws this response away, so an error
      // the user can actually read has to be left behind for the next time they
      // open it.
      const error =
        current.phase === PHASE.STARTING
          ? 'The screen picker is already open — choose a source there, or press Escape and try again.'
          : 'A recording is already in progress.';
      await setLastError(error);
      return { ok: false, error };
    }
  }

  const settings = await loadSettings();

  await setLastError(null);
  await setNotice(null);
  await setState({ phase: PHASE.STARTING, options: settings });

  // 1. The offscreen document opens the source picker and the devices itself.
  //    A display-capture stream belongs to the frame that requested it, so the
  //    document that shows the picker has to be the one that records — which is
  //    why this lives there and not here.
  const recordingId = newRecordingId();
  const quality = qualityFor(settings);
  await ensureOffscreen();
  const prepared = await toOffscreen(MSG.PREPARE, { recordingId, settings, quality });

  if (prepared?.cancelled) {
    await closeOffscreen();
    await resetState();
    if (prepared.detail) console.warn('[Omnipotent] capture never started:', prepared.detail);
    if (prepared.uncertain) {
      // Chrome would not say whether the picker was dismissed or the capture
      // backend gave up. Idle is the right place to land either way — but the
      // reason has to reach the user, or a real failure looks like nothing at all.
      await setNotice(
        `Screen capture ended before recording began. If you did not dismiss the picker, this is what Chrome reported — ${prepared.detail}`,
      );
    }
    return { ok: false, error: null, cancelled: true };
  }
  if (!prepared?.ok) {
    await closeOffscreen();
    await resetState();
    const error = prepared?.error || 'Could not open the selected source.';
    await setLastError(error);
    return { ok: false, error };
  }

  // Every downgrade shares one banner: separate setNotice calls overwrite each
  // other and only the last one would ever be seen. Collected here, set once at
  // the end, when the overlay's fate is known too.
  const downgrades = [];
  if (prepared.micDropped) downgrades.push(`Recording without your microphone. ${prepared.micDropped}`);
  if (prepared.audioDropped) {
    downgrades.push('Tab audio was not available on this system, so the recording has no tab sound.');
  }

  // 2. Countdown runs inside the page so the user sees it on what they're recording.
  const state = await setState({
    phase: PHASE.COUNTDOWN,
    recordingId,
    startedAt: null,
    pausedTotalMs: 0,
    pausedAt: null,
    micMuted: false,
  });

  // Ask for the active tab now rather than before the picker: choosing a source
  // takes as long as it takes, and the user may well have moved on by then.
  const tab = await activeTab();
  const mounted = await mountOverlay(tab, state);
  if (mounted) {
    await toTab(tab.id, {
      target: TARGET.OVERLAY,
      type: MSG.START_COUNTDOWN,
      seconds: settings.countdownSeconds,
    });
    // The page runs the countdown, and pages die: navigate, close the tab or lose
    // the content script and COUNTDOWN_DONE never arrives, leaving the session
    // waiting on a message that is not coming. Showing the countdown is the page's
    // job; starting the recorder is not, so back it with a timer here.
    scheduleCountdownBackstop(settings.countdownSeconds, true);
  } else {
    // Restricted page (chrome://, the Web Store, the PDF viewer): nothing can be
    // drawn there. That costs the user the visuals, and it used to cost them the
    // countdown itself — recording began the instant they answered the picker.
    // The wait is the point, so the worker keeps it and counts down on the badge.
    scheduleCountdownBackstop(settings.countdownSeconds, false);
    // Losing the overlay costs three visible things at once. Saying so beats
    // leaving the user to conclude the extension is broken — which is exactly
    // what a missing countdown looks like from the outside.
    downgrades.push(
      `${describeSurface(tab)} does not let extensions draw on it, so the countdown, ` +
        'camera bubble and control bar cannot appear. The toolbar icon counts down instead, ' +
        'and Stop lives in the extension popup or Chrome’s own sharing bar. Switch to an ' +
        'ordinary page and they come back on their own.',
    );
  }

  if (downgrades.length) await setNotice(downgrades.join(' '));
  return { ok: true };
}

/**
 * @param visual true when a page is drawing the countdown and will report back —
 *   the timer is then only a safety net and gets slack. False when nothing can be
 *   drawn: the timer *is* the countdown, so it runs to the second and the badge
 *   does the counting.
 */
function scheduleCountdownBackstop(seconds, visual) {
  const total = Math.max(0, Number(seconds) || 0);
  if (!visual && total >= 1) tickBadgeCountdown(total);
  const delay = total * 1000 + (visual ? 1500 : 0);
  setTimeout(() => {
    beginRecording().catch((err) => console.error('[Omnipotent] countdown backstop', err));
  }, delay);
}

/** 3 · 2 · 1 on the toolbar icon, for when the page cannot show it. */
function tickBadgeCountdown(seconds) {
  let remaining = seconds;
  const paint = async () => {
    const state = await getState();
    if (state.phase !== PHASE.COUNTDOWN) return; // cancelled, or already recording
    await chrome.action.setBadgeText({ text: String(remaining) }).catch(() => {});
    await chrome.action.setBadgeBackgroundColor({ color: '#6e7566' }).catch(() => {});
    remaining -= 1;
    if (remaining >= 1) setTimeout(paint, 1000);
  };
  paint().catch(() => {});
}

// The page's COUNTDOWN_DONE and the backstop timer can land together; both are
// allowed to, and only the first one through may start the recorder.
let beginning = null;

async function beginRecording() {
  if (beginning) return beginning;
  beginning = (async () => {
    const state = await getState();
    if (state.phase !== PHASE.COUNTDOWN) return; // stale/duplicate countdown-done
    const started = await toOffscreen(MSG.BEGIN);
    if (!started?.ok) {
      const error = started?.error || 'Recorder failed to start.';
      await setLastError(error);
      await abortSession();
      return;
    }
    const next = await setState({ phase: PHASE.RECORDING, startedAt: Date.now() });
    await broadcast(next);
  })().finally(() => {
    beginning = null;
  });
  return beginning;
}

async function pauseRecording() {
  const state = await getState();
  if (state.phase !== PHASE.RECORDING) return;
  await toOffscreen(MSG.OFFSCREEN_PAUSE);
  const next = await setState({ phase: PHASE.PAUSED, pausedAt: Date.now() });
  await broadcast(next);
}

async function resumeRecording() {
  const state = await getState();
  if (state.phase !== PHASE.PAUSED) return;
  const pausedTotalMs = state.pausedTotalMs + (Date.now() - (state.pausedAt || Date.now()));
  await toOffscreen(MSG.OFFSCREEN_RESUME);
  const next = await setState({
    phase: PHASE.RECORDING,
    pausedAt: null,
    pausedTotalMs,
  });
  await broadcast(next);
}

async function setMicMuted(muted) {
  const state = await getState();
  if (!isActivePhase(state.phase)) return;
  await toOffscreen(MSG.OFFSCREEN_MUTE, { muted });
  const next = await setState({ micMuted: muted });
  await broadcast(next);
}

async function stopRecording() {
  const state = await getState();
  if (!isActivePhase(state.phase)) return;
  const next = await setState({ phase: PHASE.SAVING });
  await broadcast(next);
  await unmountOverlays(next);
  // The offscreen document answers with RECORDING_SAVED / RECORDING_FAILED.
  await toOffscreen(MSG.OFFSCREEN_STOP);
}

async function cancelRecording() {
  const state = await getState();
  if (state.phase === PHASE.IDLE) return;
  await toOffscreen(MSG.OFFSCREEN_CANCEL);
  if (state.recordingId) await deleteChunks(state.recordingId).catch(() => {});
  await abortSession();
}

/** Tear everything down without saving. */
async function abortSession() {
  const state = await getState();
  await unmountOverlays(state);
  await closeOffscreen();
  await resetState();
  await sendSafe({
    target: TARGET.OVERLAY,
    type: MSG.STATE_CHANGED,
    state: publicState(IDLE_STATE),
  });
}

async function onRecordingSaved(meta) {
  const state = await getState();
  await unmountOverlays(state);
  await closeOffscreen();
  await resetState();
  if (meta?.id) {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`library/library.html?id=${encodeURIComponent(meta.id)}`),
    });
  }
}

async function onRecordingFailed(error) {
  await setLastError(error || 'Recording failed.');
  await abortSession();
  await chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' }).catch(() => {});
}

/* ------------------------------------------------------------- tab following */

async function followTab(tabId) {
  const state = await getState();
  if (!isActivePhase(state.phase)) return;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  await mountOverlay(tab, state);
}

chrome.tabs.onActivated.addListener(({ tabId }) => {
  followTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Content scripts die on navigation — remount once the new document is ready.
  if (changeInfo.status !== 'complete') return;
  if (!tab.active) return;
  followTab(tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
  if (tab) followTab(tab.id);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (!state.injectedTabIds.includes(tabId)) return;
  await setState({ injectedTabIds: state.injectedTabIds.filter((id) => id !== tabId) });
});

/* ------------------------------------------------------------------ routing */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET.WORKER) return undefined;

  (async () => {
    switch (message.type) {
      case MSG.START_RECORDING:
        sendResponse(await startRecording());
        break;
      case MSG.GET_STATE:
        sendResponse(publicState(await getState()));
        break;
      case MSG.COUNTDOWN_DONE:
        await beginRecording();
        sendResponse({ ok: true });
        break;
      case MSG.PAUSE:
        await pauseRecording();
        sendResponse({ ok: true });
        break;
      case MSG.RESUME:
        await resumeRecording();
        sendResponse({ ok: true });
        break;
      case MSG.SET_MIC_MUTED:
        await setMicMuted(!!message.muted);
        sendResponse({ ok: true });
        break;
      case MSG.STOP:
        await stopRecording();
        sendResponse({ ok: true });
        break;
      case MSG.CANCEL:
        await cancelRecording();
        sendResponse({ ok: true });
        break;
      case MSG.SOURCE_ENDED:
        // User hit Chrome's own "Stop sharing" bar — same path as a normal stop.
        await stopRecording();
        sendResponse({ ok: true });
        break;
      case MSG.RECORDING_SAVED:
        await onRecordingSaved(message.meta);
        sendResponse({ ok: true });
        break;
      case MSG.RECORDING_FAILED:
        await onRecordingFailed(message.error);
        sendResponse({ ok: true });
        break;
      case MSG.CAMERA_BLOCKED:
        await setNotice(
          message.blockedByPage
            ? 'This site blocks camera access for everything on the page, so the webcam bubble cannot appear here. The screen recording is unaffected.'
            : `The webcam bubble could not start. ${message.detail || ''}`.trim(),
        );
        sendResponse({ ok: true });
        break;
      case MSG.HEARTBEAT:
        // Inbound traffic resets the worker's idle timer; that's the whole point.
        sendResponse({ ok: true });
        break;
      case MSG.OPEN_LIBRARY:
        await chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') });
        sendResponse({ ok: true });
        break;
      case MSG.OPEN_PERMISSIONS:
        await chrome.tabs.create({
          url: chrome.runtime.getURL('permissions/permissions.html'),
        });
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ ok: false, error: `Unknown message ${message.type}` });
    }
  })().catch(async (err) => {
    console.error('[Omnipotent worker]', err);
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true; // async sendResponse
});

/* ------------------------------------------------------------------ startup */

async function onStartup() {
  // A crash or an extension reload mid-recording leaves chunks with no owner.
  // Nothing can play them (no header finalization), so sweep them.
  await resetState();
  await closeOffscreen();
  try {
    const moved = await migrateLegacyRecordings();
    if (moved) console.info(`[Omnipotent] migrated ${moved} recording(s) from the old name`);
  } catch (err) {
    console.warn('[Omnipotent] legacy migration failed', err);
  }
  try {
    const orphans = await orphanChunkIds();
    for (const id of orphans) await deleteChunks(id);
    if (orphans.length) {
      console.info(`[Omnipotent] cleaned ${orphans.length} interrupted recording(s)`);
    }
  } catch (err) {
    console.warn('[Omnipotent] orphan sweep failed', err);
  }
  await requestPersistence().catch(() => {});
}

chrome.runtime.onInstalled.addListener(onStartup);
chrome.runtime.onStartup.addListener(onStartup);
