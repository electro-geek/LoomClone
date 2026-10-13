// In-page overlay host: countdown, webcam bubble and control bar.
//
// Injected with chrome.scripting.executeScript, so it is a classic script and
// cannot import from common/. The few message strings below mirror
// common/messages.js — keep them in sync.
//
// Everything lives in a closed shadow root so page CSS can never reach it.
//
// The control bar is drawn here, as ordinary page content, rather than in an
// iframe: an out-of-process iframe always paints an opaque base canvas (white,
// or dark under color-scheme: dark) no matter how transparent its document is,
// so a frame can never be see-through and backdrop-filter inside one cannot
// sample the page. Drawn here it gets real translucency and real backdrop blur.
//
// The camera bubble stays an iframe because it needs the extension's origin to
// use the camera without prompting on every site.

(() => {
  if (window.__omnipotentOverlay) return;

  const MSG = {
    STATE_CHANGED: 'state-changed',
    START_COUNTDOWN: 'start-countdown',
    TEARDOWN_OVERLAY: 'teardown-overlay',
    COUNTDOWN_DONE: 'countdown-done',
    GET_STATE: 'get-state',
    PAUSE: 'pause',
    RESUME: 'resume',
    STOP: 'stop',
    CANCEL: 'cancel',
    SET_MIC_MUTED: 'set-mic-muted',
  };
  const TARGET = { WORKER: 'worker', OVERLAY: 'overlay' };
  const PHASE = { IDLE: 'idle', COUNTDOWN: 'countdown', RECORDING: 'recording', PAUSED: 'paused' };

  const SIZES = { sm: 128, md: 180, lg: 240 };
  const MARGIN = 20;

  const host = document.createElement('div');
  host.id = '__omnipotent_overlay__';
  // pointer-events: none is load-bearing. The host covers the whole viewport, and
  // `all: initial` resets pointer-events to `auto`, so without this the host
  // silently swallows every click, drag and focus attempt on the page underneath —
  // the page looks normal and is completely dead. Only the bar and bubble
  // (.float) and the drag shield opt back in.
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;';
  const root = host.attachShadow({ mode: 'closed' });

  root.innerHTML = `
    <style>
      /* Omnipotent brand system, inlined: a shadow root cannot share the
         extension's stylesheet, and the page's own CSS must never leak in. */
      :host, * { box-sizing: border-box; }
      :host { pointer-events: none; }
      .layer {
        position: fixed;
        inset: 0;
        pointer-events: none;
        --ink: #101014;
        --ink-2: #17171d;
        --ink-3: #22222a;
        --bone: #f4f1ea;
        --signal: #c0392b;
        --sage: #6e7566;
        --line: rgba(244,241,234,.14);
        --line-2: rgba(244,241,234,.24);
        --dim: rgba(244,241,234,.45);
        --mono: "Roboto Mono", "IBM Plex Mono", ui-monospace, "DejaVu Sans Mono",
                "Liberation Mono", Menlo, Consolas, monospace;
        font-family: var(--mono);
        font-size: 12px;
        line-height: 1.4;
        color: var(--bone);
      }
      .float { position: absolute; pointer-events: auto; }

      /* ------------------------------------------------------ camera bubble */
      .bubble {
        border-radius: 50%;
        border: 2px solid rgba(244,241,234,.9);
        box-shadow: 0 12px 34px rgba(0,0,0,.5);
        background: var(--ink);
        overflow: hidden;
        transition: width .16s, height .16s;
      }
      .bubble iframe {
        width: 100%; height: 100%; border: 0; display: block;
        background: transparent; border-radius: 50%;
      }

      /* -------------------------------------------------------- control bar */
      .bar {
        display: flex;
        align-items: stretch;
        height: 46px;
        border: 1px solid var(--line-2);
        border-radius: 12px;
        background: rgba(16,18,22,.86);
        -webkit-backdrop-filter: blur(16px) saturate(140%);
        backdrop-filter: blur(16px) saturate(140%);
        box-shadow: 0 12px 34px rgba(0,0,0,.45);
        color: var(--bone);
        user-select: none;
        overflow: hidden;
      }
      .grip {
        width: 24px;
        display: grid;
        place-items: center;
        cursor: grab;
        border-right: 1px solid var(--line);
        flex: none;
      }
      .grip .pips { display: grid; grid-template-columns: 3px 3px; gap: 3px; }
      .grip .pips i {
        width: 3px; height: 3px; border-radius: 50%;
        background: var(--dim); display: block;
      }
      .bar.dragging .grip { cursor: grabbing; }
      .bar.dragging .grip .pips i { background: var(--bone); }

      .status {
        display: flex;
        align-items: center;
        gap: 9px;
        padding: 0 13px;
        border-right: 1px solid var(--line);
        flex: none;
      }
      .dot {
        width: 9px; height: 9px;
        border-radius: 50%;
        background: var(--signal);
        box-shadow: 0 0 0 4px rgba(192,57,43,.22);
        flex: none;
        animation: blink 1.4s ease-in-out infinite;
      }
      .bar.paused .dot {
        background: var(--sage);
        box-shadow: 0 0 0 4px rgba(110,117,102,.22);
        animation: none;
      }
      @keyframes blink { 50% { opacity: .25; } }
      .time {
        font-variant-numeric: tabular-nums;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: .01em;
        white-space: nowrap;
        min-width: 46px;
      }
      .actions { display: flex; align-items: center; gap: 7px; padding: 0 9px; }

      .bar button {
        display: grid;
        place-items: center;
        width: 28px; height: 28px;
        padding: 0;
        border: 1px solid var(--line-2);
        border-radius: 8px;
        background: rgba(244,241,234,.06);
        color: var(--bone);
        font-family: var(--mono);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: .08em;
        text-transform: uppercase;
        cursor: pointer;
        transition: background .12s ease, border-color .12s ease, transform .12s ease;
      }
      .bar button:hover {
        background: rgba(244,241,234,.16);
        border-color: var(--dim);
        transform: translateY(-1px);
      }
      .bar button:focus-visible { outline: 2px solid var(--sage); outline-offset: 2px; }
      .bar button.armed { background: var(--signal); border-color: var(--signal); }
      .bar button.on { background: var(--signal); border-color: var(--signal); }
      /* Stop stays solid signal red — the one control that must never be missed. */
      .bar button.stop {
        width: auto;
        gap: 8px;
        padding: 0 14px;
        grid-auto-flow: column;
        background: var(--signal);
        border-color: var(--signal);
        color: var(--bone);
        font-weight: 700;
        white-space: nowrap;
      }
      .bar button.stop:hover { background: #d4503f; border-color: #d4503f; }
      .bar button.stop:disabled { opacity: .6; cursor: default; }
      .bar svg { width: 13px; height: 13px; fill: currentColor; display: block; }

      /* ---------------------------------------------------------- countdown */
      .countdown {
        position: fixed;
        inset: 0;
        display: grid;
        place-items: center;
        background: rgba(8,8,11,.55);
        pointer-events: none;
      }
      .count-card {
        display: grid;
        place-items: center;
        gap: 8px;
        min-width: 210px;
        padding: 28px 36px 22px;
        background: rgba(16,18,22,.92);
        border: 1px solid var(--line-2);
        border-radius: 16px;
        box-shadow: 0 24px 60px rgba(0,0,0,.55);
      }
      .count-num {
        font-size: 104px;
        font-weight: 700;
        line-height: 1;
        letter-spacing: -.05em;
        font-variant-numeric: tabular-nums;
        color: var(--bone);
        animation: pop .9s ease-out;
      }
      .count-label {
        font-size: 10px;
        font-weight: 600;
        letter-spacing: .28em;
        text-transform: uppercase;
        color: var(--dim);
      }
      .count-rule { width: 100%; border-top: 1px solid var(--line); }
      @keyframes pop {
        0%   { transform: scale(.7); opacity: .2; }
        40%  { transform: scale(1);  opacity: 1; }
        100% { transform: scale(1);  opacity: 1; }
      }
      @media (prefers-reduced-motion: reduce) {
        .count-num, .dot { animation: none; }
      }

      .shield { position: fixed; inset: 0; pointer-events: auto; cursor: grabbing; }
    </style>
    <div class="layer" id="layer"></div>
  `;

  const layer = root.getElementById('layer');
  const state = { phase: PHASE.IDLE, options: null };
  let disposed = false;
  let cameraBox = null;
  let bar = null;
  let barEls = null;
  let countdownEl = null;
  let countdownTimer = null;
  let ticker = null;
  let poller = null;
  let drag = null;
  let shield = null;

  const toWorker = (type, payload = {}) =>
    chrome.runtime.sendMessage({ target: TARGET.WORKER, type, ...payload }).catch(() => undefined);

  function mountHost() {
    if (disposed) return;
    if (!host.isConnected) (document.body || document.documentElement).append(host);
  }

  /* ------------------------------------------------------------- positioning */

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function placeBox(box, left, top) {
    const maxLeft = window.innerWidth - box.offsetWidth - 4;
    const maxTop = window.innerHeight - box.offsetHeight - 4;
    box.style.left = `${clamp(left, 4, Math.max(4, maxLeft))}px`;
    box.style.top = `${clamp(top, 4, Math.max(4, maxTop))}px`;
  }

  function getSettings() {
    return chrome.storage.local.get('settings').then((stored) => stored.settings || {});
  }

  function saveSetting(patch) {
    return chrome.storage.local
      .get('settings')
      .then((stored) =>
        chrome.storage.local.set({ settings: { ...(stored.settings || {}), ...patch } }),
      )
      .catch(() => {});
  }

  /* ---------------------------------------------------------- camera bubble */

  async function mountCamera() {
    if (cameraBox || disposed) return;
    const settings = await getSettings();
    if (cameraBox || disposed) return;
    const diameter = SIZES[settings.cameraSize] || SIZES.md;

    cameraBox = document.createElement('div');
    cameraBox.className = 'float bubble';
    const frame = document.createElement('iframe');
    // Delegate before navigating: the permissions policy for a frame is fixed
    // when it loads, so `allow` has to be in place before `src` is assigned.
    // (This still cannot win against a page whose own Permissions-Policy header
    // sets `camera=()` — that disables the camera for every frame it contains.)
    frame.allow = 'camera; microphone';
    frame.src = chrome.runtime.getURL('overlay/camera.html');
    frame.setAttribute('scrolling', 'no');
    cameraBox.append(frame);
    layer.append(cameraBox);

    cameraBox.style.width = `${diameter}px`;
    cameraBox.style.height = `${diameter}px`;
    const pos = settings.cameraPosition || {
      left: MARGIN,
      top: window.innerHeight - diameter - MARGIN,
    };
    placeBox(cameraBox, pos.left, pos.top);
  }

  function unmountCamera() {
    cameraBox?.remove();
    cameraBox = null;
  }

  /* ------------------------------------------------------------ control bar */

  const ICON = {
    grip: '<span class="pips"><i></i><i></i><i></i><i></i><i></i><i></i></span>',
    pause:
      '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3.5" height="11" rx="1"/><rect x="9" y="2.5" width="3.5" height="11" rx="1"/></svg>',
    play: '<svg viewBox="0 0 16 16"><path d="M4.5 2.6 13 8l-8.5 5.4z"/></svg>',
    mic: '<svg viewBox="0 0 16 16"><path d="M8 1.5a2.2 2.2 0 0 1 2.2 2.2v4a2.2 2.2 0 0 1-4.4 0v-4A2.2 2.2 0 0 1 8 1.5Z"/><path d="M4 7.2a.8.8 0 0 0-1.6 0 5.6 5.6 0 0 0 4.8 5.54V14.5a.8.8 0 0 0 1.6 0v-1.76A5.6 5.6 0 0 0 13.6 7.2a.8.8 0 0 0-1.6 0 4 4 0 0 1-8 0Z"/></svg>',
    trash:
      '<svg viewBox="0 0 16 16"><path d="M6.4 1.8h3.2a.8.8 0 0 1 .8.8v.6h3a.7.7 0 0 1 0 1.4h-.5l-.7 8.4a1.6 1.6 0 0 1-1.6 1.5H5.4a1.6 1.6 0 0 1-1.6-1.5L3.1 4.6h-.5a.7.7 0 1 1 0-1.4h3v-.6a.8.8 0 0 1 .8-.8Z"/></svg>',
    stop: '<svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="2"/></svg>',
  };

  function button(className, title, html) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = className;
    el.title = title;
    el.innerHTML = html;
    return el;
  }

  async function mountControls() {
    if (bar || disposed) return;
    const settings = await getSettings();
    if (bar || disposed) return;

    bar = document.createElement('div');
    bar.className = 'float bar';

    const grip = document.createElement('div');
    grip.className = 'grip';
    grip.title = 'Drag to move';
    grip.innerHTML = ICON.grip;

    const status = document.createElement('div');
    status.className = 'status';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = '00:00';
    status.append(dot, time);

    const pause = button('', 'Pause', ICON.pause);
    const mic = button('', 'Mute microphone', ICON.mic);
    const cancel = button('', 'Discard this recording', ICON.trash);
    const stop = button('stop', 'Stop and save', `${ICON.stop}<span>Stop</span>`);

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(pause, mic, cancel, stop);

    bar.append(grip, status, actions);
    layer.append(bar);
    barEls = { time, pause, mic, cancel, stop };

    const pos = settings.controlsPosition || {
      left: Math.round((window.innerWidth - bar.offsetWidth) / 2),
      top: window.innerHeight - bar.offsetHeight - MARGIN,
    };
    placeBox(bar, pos.left, pos.top);

    grip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const rect = bar.getBoundingClientRect();
      startDrag('controls', bar, event.clientX - rect.left, event.clientY - rect.top);
    });

    pause.addEventListener('click', async () => {
      await toWorker(state.phase === PHASE.PAUSED ? MSG.RESUME : MSG.PAUSE);
      await sync();
    });

    mic.addEventListener('click', async () => {
      await toWorker(MSG.SET_MIC_MUTED, { muted: !state.micMuted });
      await sync();
    });

    // No confirm() — a modal dialog would be captured by the recording and block
    // the frame. The button arms itself instead.
    cancel.addEventListener('click', async () => {
      if (cancel.dataset.armed !== '1') {
        cancel.dataset.armed = '1';
        cancel.classList.add('armed');
        cancel.title = 'Click again to discard';
        setTimeout(() => {
          if (!bar) return;
          cancel.dataset.armed = '0';
          cancel.classList.remove('armed');
          cancel.title = 'Discard this recording';
        }, 3000);
        return;
      }
      await toWorker(MSG.CANCEL);
    });

    stop.addEventListener('click', async () => {
      stop.disabled = true;
      stop.querySelector('span').textContent = 'Saving…';
      await toWorker(MSG.STOP);
    });

    paintControls();
    startTicker();
  }

  function unmountControls() {
    stopTicker();
    bar?.remove();
    bar = null;
    barEls = null;
  }

  function paintControls() {
    if (!bar || !barEls) return;
    const paused = state.phase === PHASE.PAUSED;
    bar.classList.toggle('paused', paused);
    barEls.pause.title = paused ? 'Resume' : 'Pause';
    barEls.pause.innerHTML = paused ? ICON.play : ICON.pause;
    barEls.mic.hidden = !state.options?.useMic;
    barEls.mic.classList.toggle('on', !!state.micMuted);
    barEls.mic.title = state.micMuted ? 'Unmute microphone' : 'Mute microphone';
    tick();
  }

  function tick() {
    if (!barEls) return;
    const now = Date.now();
    let ms = 0;
    if (state.startedAt) {
      const pausedTotal = (state.pausedTotalMs || 0) + (state.pausedAt ? now - state.pausedAt : 0);
      ms = Math.max(0, now - state.startedAt - pausedTotal);
    }
    const total = Math.round(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    barEls.time.textContent = hours
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${pad(minutes)}:${pad(seconds)}`;
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(tick, 500);
    // Also a keepalive: inbound messages reset the worker's idle timer.
    poller = setInterval(sync, 5000);
  }

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    if (poller) clearInterval(poller);
    ticker = null;
    poller = null;
  }

  async function sync() {
    const next = await toWorker(MSG.GET_STATE);
    if (next) render(next);
  }

  /* --------------------------------------------------------------- countdown */

  function runCountdown(seconds) {
    clearCountdown();
    if (!seconds || seconds < 1) {
      finishCountdown();
      return;
    }
    countdownEl = document.createElement('div');
    countdownEl.className = 'countdown';
    const card = document.createElement('div');
    card.className = 'count-card';
    const num = document.createElement('div');
    num.className = 'count-num';
    const rule = document.createElement('div');
    rule.className = 'count-rule';
    const label = document.createElement('div');
    label.className = 'count-label';
    label.textContent = 'Get ready';
    card.append(num, rule, label);
    countdownEl.append(card);
    layer.append(countdownEl);

    let remaining = seconds;
    const paint = () => {
      num.textContent = String(remaining);
      num.style.animation = 'none';
      void num.offsetWidth; // restart the CSS animation on every tick
      num.style.animation = '';
    };
    paint();
    countdownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearCountdown();
        finishCountdown();
        return;
      }
      paint();
    }, 1000);
  }

  function clearCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    countdownEl?.remove();
    countdownEl = null;
  }

  function finishCountdown() {
    toWorker(MSG.COUNTDOWN_DONE);
  }

  /* -------------------------------------------------------------------- drag */

  // A shield keeps every pointermove in this document — otherwise the cursor can
  // cross into the camera iframe and we stop hearing about it.
  function startDrag(kind, box, grabX, grabY) {
    drag = { kind, box, grabX, grabY };
    box.classList.add('dragging');
    shield = document.createElement('div');
    shield.className = 'shield';
    layer.append(shield);
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', endDrag, true);
    window.addEventListener('pointercancel', endDrag, true);
  }

  function onDragMove(event) {
    if (!drag) return;
    event.preventDefault();
    placeBox(drag.box, event.clientX - drag.grabX, event.clientY - drag.grabY);
  }

  function endDrag() {
    if (!drag) return;
    const { kind, box } = drag;
    box.classList.remove('dragging');
    const position = { left: parseInt(box.style.left, 10), top: parseInt(box.style.top, 10) };
    saveSetting(kind === 'camera' ? { cameraPosition: position } : { controlsPosition: position });
    drag = null;
    shield?.remove();
    shield = null;
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', endDrag, true);
    window.removeEventListener('pointercancel', endDrag, true);
  }

  // The bubble is an iframe, so it hands its drags over to us.
  function onFrameMessage(event) {
    const data = event.data;
    if (!data || data.channel !== 'omnipotent') return;
    if (!cameraBox || event.source !== cameraBox.firstChild.contentWindow) return;

    if (data.type === 'drag-start') {
      startDrag('camera', cameraBox, data.grabX, data.grabY);
    } else if (data.type === 'resize') {
      const diameter = SIZES[data.size] || SIZES.md;
      const left = parseInt(cameraBox.style.left, 10);
      const top = parseInt(cameraBox.style.top, 10);
      cameraBox.style.width = `${diameter}px`;
      cameraBox.style.height = `${diameter}px`;
      placeBox(cameraBox, left, top);
      saveSetting({ cameraSize: data.size });
    }
  }

  function onViewportResize() {
    for (const box of [cameraBox, bar]) {
      if (box) placeBox(box, parseInt(box.style.left, 10), parseInt(box.style.top, 10));
    }
  }

  window.addEventListener('message', onFrameMessage);
  window.addEventListener('resize', onViewportResize);

  /* ------------------------------------------------------------------ render */

  async function render(next) {
    Object.assign(state, next);
    if (state.phase === PHASE.IDLE) {
      teardown();
      return;
    }
    mountHost();

    if (state.options?.useCamera) await mountCamera();
    else unmountCamera();
    if (disposed) return;

    if (state.phase === PHASE.RECORDING || state.phase === PHASE.PAUSED) {
      clearCountdown();
      await mountControls();
      if (disposed) unmountControls();
      else paintControls();
    }
  }

  function teardown() {
    if (disposed) return;
    disposed = true;
    clearCountdown();
    endDrag();
    unmountCamera();
    unmountControls();
    host.remove();
    chrome.runtime.onMessage.removeListener(onWorkerMessage);
    window.removeEventListener('message', onFrameMessage);
    window.removeEventListener('resize', onViewportResize);
    window.__omnipotentOverlay = false;
  }

  function onWorkerMessage(message) {
    if (message?.target !== TARGET.OVERLAY) return undefined;
    if (message.type === MSG.STATE_CHANGED) {
      render(message.state || {});
    } else if (message.type === MSG.START_COUNTDOWN) {
      mountHost();
      runCountdown(message.seconds);
    } else if (message.type === MSG.TEARDOWN_OVERLAY) {
      teardown();
    }
    return undefined;
  }

  chrome.runtime.onMessage.addListener(onWorkerMessage);

  window.__omnipotentOverlay = true;
  mountHost();
})();
