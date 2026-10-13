# Omnipotent

A screen recorder that runs entirely inside Chrome. Screen + microphone + a round webcam
bubble, a countdown, an in-page control bar, and a library of your recordings — with
**no account, no upload, and no backend**. Every byte stays in your browser profile on
your own machine.

Run it unpacked, or [publish it to the Chrome Web Store](#publishing-to-the-chrome-web-store).

![icon](extension/icons/icon128.png)

## Install

```bash
node tools/make-icons.mjs      # generates extension/icons/*.png (no dependencies)
```

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Pin Omnipotent to the toolbar and click it
5. First run only: click **Grant** and allow camera + microphone on the page that opens

The grant is attached to the extension's own origin, so pages you record are never asked
for permission.

## Recording

Click the toolbar icon, choose what you want:

| Option | What it does |
| --- | --- |
| **Microphone** | Your narration. Pick a specific input device. |
| **Camera bubble** | Round webcam overlay, draggable, three sizes, mirror toggle. |
| **Tab / system audio** | Audio playing in the captured tab. Also tick Chrome's own "Share audio" box in the picker. |
| **Quality** | 720p / 1080p / Native, 30 or 60 fps. |
| **Format** | MP4 (seekable, recommended) or WebM. See the codec note below. |
| **Countdown** | Off, 3s or 5s. |

Then **Start recording** → pick a screen, window or tab in Chrome's picker → countdown → go.

While recording, a control bar floats over the page with the elapsed timer, pause/resume,
mic mute, discard and stop. Both the bar and the bubble are draggable and **follow you from
tab to tab**. Recording keeps running when you navigate, switch tabs or switch windows.

Stop and the recording opens in your library: play, rename, download, delete.

## How it works

```
popup ──► service worker ──┬──► offscreen document
                           │      getDisplayMedia()  ← Chrome's native picker
                           │      + getUserMedia(mic)
                           │      → WebAudio mix → MediaRecorder
                           │      → one IndexedDB chunk per second
                           │
                           └──► content script overlay (countdown, bubble, control bar)

stop ──► chunks stitched into one Blob ──► IndexedDB ──► library page
```

- **Everything capture-related happens in the offscreen document.** MV3 service workers
  have no DOM and cannot hold a MediaStream, and an offscreen document keeps recording no
  matter what happens to your tabs.
- **The offscreen document opens the picker itself, with `getDisplayMedia()`.** This is the
  part worth knowing if you ever refactor it: a display-capture stream belongs to the frame
  that requested it. `chrome.desktopCapture.chooseDesktopMedia` looks like the natural fit,
  but from a service worker it *requires* a `targetTab`, and that scopes the resulting
  stream to frames in that tab — the offscreen document then fails `getUserMedia` with
  `AbortError: Invalid state`. Handing a stream id across documents does not work at all.
  Offscreen documents may call `getDisplayMedia()` without a user gesture — that is exactly
  what the `DISPLAY_MEDIA` creation reason is for — so the picker and the capture live in
  the same document and no `desktopCapture` permission is needed.
- **The webcam is captured in the offscreen document, not in the page.** The bubble is an
  extension-origin iframe injected into the page, but it never calls `getUserMedia` — it
  only paints frames handed to it. This matters because a site can ship
  `Permissions-Policy: camera=()`, which disables the camera for *every frame the page
  contains*; a subframe cannot re-enable what the top document switched off, so a bubble
  that captured for itself simply died on such sites (claude.ai is one). Capturing in the
  offscreen document — top-level and extension-owned, beyond the reach of any page policy —
  fixes that everywhere. Frames travel over a `BroadcastChannel`, which every extension page
  shares, because `chrome.runtime` messaging only carries JSON-ish values and would flatten
  an `ImageBitmap`. The bubble is still ordinary page content, so the screen capture records
  it exactly as you see it.
- **The control bar is drawn directly into the overlay's closed shadow root**, not in an
  iframe. An out-of-process iframe always paints an opaque base canvas — white by default,
  dark under `color-scheme: dark` — no matter how transparent its own document is, and
  `backdrop-filter` inside one cannot sample the parent page. So a framed bar can never be
  see-through. Drawn as page content it gets real translucency and real backdrop blur, and
  it needs no extension origin because it only sends runtime messages, which content
  scripts can do.
- **The overlay host is `pointer-events: none`, and that is load-bearing.** It is a fixed
  element covering the whole viewport at the maximum z-index, and `all: initial` resets
  `pointer-events` to `auto` — so without the explicit override it silently swallows every
  click, drag and keystroke meant for the page while looking completely normal. Only the
  bar, the bubble and the drag shield opt back in. `tools/e2e.mjs` asserts this by clicking
  a button, typing into a field and dragging on a canvas mid-recording.
- **MP4 first, when the machine can encode it.** MP4 carries a duration, so the scrubber
  works; MediaRecorder's WebM does not, and the library patches that at playback time. What
  ends up *inside* the MP4 depends on your machine: Chrome builds with an H.264 encoder
  produce H.264/AAC, and builds without one (common on Linux) produce VP9/Opus in an MP4
  container. Both seek correctly and play in any modern player; only quite old players
  object to VP9-in-MP4. Pick WebM in the popup if you'd rather have the conventional
  container for VP9.
- **Chunked writes.** One IndexedDB row per second keeps memory flat on long recordings,
  instead of growing an in-memory array until the tab dies.

## Where the files live

There is no server. Recordings are Blobs in the extension's own IndexedDB, which Chrome
stores under your profile:

```
~/.config/google-chrome/Default/IndexedDB/chrome-extension_<extension-id>_0.indexeddb.leveldb
```

The extension requests `unlimitedStorage` (no per-origin quota) and calls
`navigator.storage.persist()` (Chrome won't evict recordings when the disk fills). Budget
roughly **35–40 MB/min at 1080p30**, about 2.2 GB/hour — the library header shows how much
you're using, and Delete is one click.

To get a file out of the browser, use **Download** in the library. To share it, upload it
wherever you like; that part is deliberately yours.

## Design

The interface is the brand kit made real — see `brand/brandkit.png`. Ink canvas
(`#101014`), bone type (`#F4F1EA`), rounded panels with hairline borders and soft shadows,
tiny wide-tracked uppercase labels, monospace throughout.

Colour is disciplined: **signal red `#C0392B` appears only where recording happens** — the
Start button, the live dot, Stop, the toolbar badge — and **sage `#6E7566` carries every
secondary state**: toggles when on, "Allowed", paused, saving. That is why the red reads as
meaning rather than decoration.

The logo is the **O of the name drawn as an aperture ring with a record dot at its centre**
— capture, contained — with a shutter notch cut at 45°. `brand/omnipotent-mark.svg` is the
master; `tools/make-icons.mjs` redraws the same construction for the 16/48/128 icons, so
they cannot drift apart. In-app the bare ring-and-dot is used; the tiled version is the app
icon only.

Tokens and components live in `extension/common/brand.css`, shared by the popup, permissions
page and library. Two places carry their own copy because they cannot reach that stylesheet:
the overlay's closed shadow root (inlined at the top of `content/overlay.js`) and the
camera-bubble iframe.

One deliberate compromise: **no web font.** Nothing here touches the network, so the stack
is `"Roboto Mono", "IBM Plex Mono", ui-monospace, …` — it picks up Roboto Mono if you have
it installed and falls back to the platform monospace face otherwise.

## Known limitations

- **Restricted pages.** Chrome forbids script injection on `chrome://` pages, the Chrome
  Web Store and the built-in PDF viewer. Capture still works there, but the countdown,
  bubble and control bar can't be drawn. Stop from the extension popup (or Chrome's own
  "Stop sharing" bar) in that case. If you start a recording from such a page the countdown
  is skipped entirely.
- **The bubble is drawn per tab.** If you record your *entire screen* and switch to another
  application, the bubble stays behind in Chrome — it's page content, not an OS window.
  Recording a screen while working in Chrome is the intended use.
- **Hover controls are recorded.** The size/mirror buttons on the bubble appear while your
  cursor is over it and are captured like anything else on screen.
- **Tab audio can be refused by the system.** On Linux/Wayland the desktop portal may not
  offer system audio at all. Rather than fail the recording, capture retries without it and
  the popup says so.
- **No editing.** Trim and crop are not implemented; this records and stores.
- **Chrome only.** MV3 offscreen documents are a Chrome API.

## Publishing to the Chrome Web Store

Nothing here talks to a server, so the listing is unusually simple: there is no
privacy policy to host and no data disclosures to make beyond "none".

### 1. Build the upload

```bash
node tools/make-icons.mjs   # only if extension/icons/*.png are missing
node tools/package.mjs      # -> dist/omnipotent-screen-recorder-v<version>.zip
```

`tools/package.mjs` zips the *contents* of `extension/`, so `manifest.json` lands at
the zip root. Zipping the folder instead is the most common upload rejection, and
the script fails loudly rather than let that through. It also checks the version
format, the 132-character description limit and that all three icons exist.

### 2. Register

A Chrome Web Store developer account costs a **one-time $5 fee** and needs a
verified email address: <https://chrome.google.com/webstore/devconsole>.

### 3. Listing assets you have to make yourself

| Asset | Requirement |
| --- | --- |
| Store icon | 128x128 — already in `extension/icons/icon128.png` |
| Screenshots | at least one, 1280x800 or 640x400 (up to five) |
| Small promo tile | 440x280, optional but it gets you into more surfaces |
| Category | Workflow & Planning, or Productivity |

### 4. Permission justifications

Every permission is used, and the console makes you justify each one. These are
accurate for this code:

| Permission | Why |
| --- | --- |
| `offscreen` | MV3 service workers have no DOM and cannot hold a `MediaStream`. The offscreen document owns `getDisplayMedia`, the recorder and the webcam. |
| `storage` | Recording settings, plus session state that must survive the worker being evicted mid-recording. |
| `unlimitedStorage` | Recordings are stored as IndexedDB blobs on the user's own machine; a screen recording exceeds the default quota within minutes. |
| `scripting` | Injects the in-page overlay — countdown, control bar and webcam bubble — into the page being recorded. |
| `tabs` | The overlay follows the user from tab to tab while recording, so the extension must know which tab is active and when it changes. |
| `downloads` | Saves a finished recording to the user's Downloads folder from the library. |
| `<all_urls>` | The overlay has to be drawable on whatever page the user happens to be recording, and that page is not known in advance. |

### 5. Privacy tab

- **Single purpose:** record the user's screen, microphone and webcam locally.
- **Data collected:** none. Nothing leaves the browser profile — no analytics, no
  accounts, no network requests of any kind.
- Tick the three certification boxes and skip the privacy-policy URL, which is
  only required if you collect something.

### 6. Review

Broad host permissions mean a human usually looks at it, so expect days rather
than hours. Rejections quote the specific policy — fix and resubmit from the same
listing. To ship an update afterwards, bump `version` in `extension/manifest.json`,
repackage, and upload to the existing item; the store rejects a re-upload of a
version number it already has.

## Layout

```
extension/
  manifest.json
  background/service-worker.js   session state machine, picker, tab following
  offscreen/offscreen.js         the recorder: streams, mixing, MediaRecorder, chunks
  content/overlay.js             shadow-DOM host: countdown, control bar, drag
  overlay/camera.*               webcam bubble — paints frames, never captures
  popup/                         capture settings + start
  permissions/                   one-time camera + mic grant
  library/                       recordings list and player
  common/                        db, settings, message contract, formatting, mime
  common/brand.css               the design system (tokens + components)
tools/make-icons.mjs             dependency-free PNG icon generator
tools/package.mjs                builds the Chrome Web Store upload zip
tools/e2e.mjs                    dependency-free end-to-end test (drives real Chrome)
```

## Development

No build step — it's plain ES modules. Edit a file, hit reload on
`chrome://extensions`, and reload any tab you want the content script re-injected into.

### Tests

```bash
node tools/e2e.mjs              # headless
node tools/e2e.mjs --headful    # real window, parked off-screen
node tools/verify-capture.mjs   # proves real pixels are captured
```

`e2e.mjs` launches a throwaway Chrome profile with the extension loaded, a fake camera and
microphone, and an auto-selected capture source, then drives two complete recordings (MP4
and WebM) through the real service worker. It asserts what actually landed in IndexedDB —
duration, dimensions, thumbnail, that the file decodes and *seeks*, that the camera bubble
and control bar iframes really mounted with a live feed, that chunk rows were cleaned up,
and that the overlay and offscreen document were torn down. It writes both recordings to
`/tmp/omnipotent-e2e-recording.{mp4,webm}` for inspection:

```bash
ffprobe -hide_banner /tmp/omnipotent-e2e-recording.webm
ffmpeg -i /tmp/omnipotent-e2e-recording.webm -af volumedetect -f null /dev/null
```

`verify-capture.mjs` exists because the fake-device flag substitutes a synthetic pattern for
*all* video capture, so `e2e.mjs` proves the pipeline but not the pixels. This one runs with
no fake devices, camera and mic switched off, and pins the picker to its own local test tab
— so it records real captured content without ever touching your desktop. Extract a frame
and look at it:

```bash
ffmpeg -i /tmp/omnipotent-real-pixels.mp4 -vf "select=eq(n\,40)" -vframes 1 frame.png
```

Neither needs an npm install — just Chrome and Node 18+.

Debugging:

- **Service worker** — `chrome://extensions` → Omnipotent → *service worker*
- **Offscreen document** — same inspector list, appears while recording
- **Webcam bubble** — right-click it → *Inspect* picks the iframe
- **Control bar** — it lives in a closed shadow root, so Inspect won't reach it; debug it
  from the content script's console (the page's own DevTools, "top" context)

```bash
node --check extension/background/service-worker.js   # syntax check any file
```
