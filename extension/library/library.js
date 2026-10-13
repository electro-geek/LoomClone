// The local library. Reads straight from IndexedDB — this page is the entire
// "file manager" for recordings; there is no server anywhere in the loop.

import { MSG, TARGET } from '../common/messages.js';
import {
  deleteRecording,
  getRecording,
  listRecordings,
  migrateLegacyRecordings,
  renameRecording,
  requestPersistence,
  storageEstimate,
} from '../common/db.js';
import { formatBytes, formatClock, formatDate, safeFilename } from '../common/format.js';

const el = {
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  storage: document.getElementById('storage-line'),
  stats: document.getElementById('stats'),
  count: document.getElementById('count-line'),
  search: document.getElementById('search'),
  newBtn: document.getElementById('new-btn'),
  modal: document.getElementById('modal'),
  modalClose: document.getElementById('modal-close'),
  player: document.getElementById('player'),
  titleInput: document.getElementById('title-input'),
  modalMeta: document.getElementById('modal-meta'),
  download: document.getElementById('download-btn'),
  delete: document.getElementById('delete-btn'),
};

let items = [];
let filter = '';
let open = null; // { meta, url }

/* -------------------------------------------------------------------- list */

async function refresh() {
  items = await listRecordings();
  renderGrid();
  renderStorage();
}

function visibleItems() {
  if (!filter) return items;
  const needle = filter.toLowerCase();
  return items.filter((item) => item.title.toLowerCase().includes(needle));
}

function renderGrid() {
  const list = visibleItems();
  el.grid.textContent = '';
  el.empty.classList.toggle('hidden', items.length > 0);

  list.forEach((item, index) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (item.thumbnail) thumb.style.backgroundImage = `url("${item.thumbnail}")`;
    else thumb.textContent = '[ NO PREVIEW ]';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = formatClock(item.durationMs);
    thumb.append(badge);

    const body = document.createElement('div');
    body.className = 'card-body';

    const top = document.createElement('div');
    top.className = 'card-top';
    const id = document.createElement('span');
    id.className = 'card-id';
    id.append(pixel('signal'), document.createTextNode(`REC·${String(index + 1).padStart(2, '0')}`));
    top.append(id, tag((item.ext || 'webm').toUpperCase(), 'cx-tag-bone'));

    const title = document.createElement('h3');
    title.className = 'card-title';
    title.textContent = item.title;
    title.title = item.title;

    const tags = document.createElement('div');
    tags.className = 'card-tags';
    if (item.width && item.height) tags.append(tag(`${item.width}×${item.height}`));
    if (item.hasMic) tags.append(tag('Mic', 'cx-tag-sage'));
    if (item.hasCamera) tags.append(tag('Cam'));
    if (item.hasTabAudio) tags.append(tag('Tab audio'));

    const foot = document.createElement('div');
    foot.className = 'card-foot';
    const when = document.createElement('span');
    when.textContent = `${formatDate(item.createdAt)} · ${formatBytes(item.size)}`;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '\u2192';
    foot.append(when, arrow);

    body.append(top, title, tags, foot);
    card.append(thumb, body);
    card.addEventListener('click', () => openRecording(item.id));
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openRecording(item.id);
      }
    });
    el.grid.append(card);
  });

  el.count.textContent = `${list.length} shown / ${items.length} total`;
}

function pixel(kind) {
  const span = document.createElement('span');
  span.className = kind === 'signal' ? 'px' : `px px-${kind}`;
  return span;
}

function tag(text, variant) {
  const span = document.createElement('span');
  span.className = `cx-tag${variant ? ` ${variant}` : ''}`;
  span.textContent = text;
  return span;
}

async function renderStorage() {
  const { usage, quota } = await storageEstimate();
  const mine = items.reduce((sum, item) => sum + (item.size || 0), 0);
  const persisted = (await navigator.storage?.persisted?.()) ?? false;
  const totalMs = items.reduce((sum, item) => sum + (item.durationMs || 0), 0);

  el.storage.textContent = persisted
    ? 'Stored in this browser profile · protected from eviction · never uploaded'
    : 'Stored in this browser profile · eviction protection off · never uploaded';

  const cells = [
    { num: String(items.length), label: 'Recordings', dot: 'signal' },
    { num: formatClock(totalMs), label: 'Total length', dot: 'sage' },
    { num: formatBytes(mine), label: 'Video on disk', dot: 'bone' },
    {
      num: quota ? formatBytes(Math.max(0, quota - usage)) : '—',
      label: 'Space free',
      dot: 'dim',
    },
  ];

  el.stats.textContent = '';
  for (const cell of cells) {
    const box = document.createElement('div');
    box.className = 'cx-kv';
    const num = document.createElement('span');
    num.className = 'cx-kv-num';
    num.textContent = cell.num;
    const lbl = document.createElement('span');
    lbl.className = 'cx-kv-lbl';
    lbl.append(pixel(cell.dot), document.createTextNode(cell.label));
    box.append(num, lbl);
    el.stats.append(box);
  }
}

/* ------------------------------------------------------------------ player */

async function openRecording(id) {
  const record = await getRecording(id);
  if (!record) return;
  closePlayer(false);

  const url = URL.createObjectURL(record.blob);
  open = { meta: record, url };

  el.player.src = url;
  el.titleInput.value = record.title;
  el.modalMeta.textContent = [
    formatDate(record.createdAt),
    formatClock(record.durationMs),
    formatBytes(record.size),
    record.width && record.height ? `${record.width}×${record.height}` : null,
    (record.ext || 'webm').toUpperCase(),
  ]
    .filter(Boolean)
    .join(' · ');

  el.modal.classList.remove('hidden');
  el.delete.textContent = 'Delete';
  el.delete.dataset.armed = '0';
  fixSeeking(el.player);
  el.player.play().catch(() => {});
}

/**
 * WebM written by MediaRecorder carries no duration, so the scrubber is dead
 * until the browser has walked the file. Forcing a seek past the end makes it
 * do that, after which everything behaves. MP4 recordings skip this entirely.
 */
function fixSeeking(video) {
  const onMeta = () => {
    if (video.duration !== Infinity && !Number.isNaN(video.duration)) return;
    const onUpdate = () => {
      video.removeEventListener('timeupdate', onUpdate);
      video.currentTime = 0;
    };
    video.addEventListener('timeupdate', onUpdate);
    video.currentTime = 1e101;
  };
  video.addEventListener('loadedmetadata', onMeta, { once: true });
}

function closePlayer(hide = true) {
  el.player.pause();
  el.player.removeAttribute('src');
  el.player.load();
  if (open?.url) URL.revokeObjectURL(open.url);
  open = null;
  if (hide) el.modal.classList.add('hidden');
}

/* ----------------------------------------------------------------- actions */

el.titleInput.addEventListener('change', async () => {
  if (!open) return;
  const title = el.titleInput.value.trim() || 'Untitled recording';
  el.titleInput.value = title;
  await renameRecording(open.meta.id, title);
  open.meta.title = title;
  await refresh();
});

el.download.addEventListener('click', async () => {
  if (!open) return;
  const filename = safeFilename(open.meta.title, open.meta.ext);
  try {
    await chrome.downloads.download({ url: open.url, filename, saveAs: true });
  } catch {
    // Fall back to a plain anchor if the downloads API refuses the blob URL.
    const anchor = document.createElement('a');
    anchor.href = open.url;
    anchor.download = filename;
    anchor.click();
  }
});

el.delete.addEventListener('click', async () => {
  if (!open) return;
  if (el.delete.dataset.armed !== '1') {
    el.delete.dataset.armed = '1';
    el.delete.textContent = 'Click again to delete';
    setTimeout(() => {
      if (!open) return;
      el.delete.dataset.armed = '0';
      el.delete.textContent = 'Delete';
    }, 3000);
    return;
  }
  const { id } = open.meta;
  closePlayer();
  await deleteRecording(id);
  await refresh();
});

el.modalClose.addEventListener('click', () => closePlayer());
el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) closePlayer();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !el.modal.classList.contains('hidden')) closePlayer();
});

el.search.addEventListener('input', () => {
  filter = el.search.value.trim();
  renderGrid();
});

el.newBtn.addEventListener('click', () => {
  chrome.runtime
    .sendMessage({ target: TARGET.WORKER, type: MSG.START_RECORDING })
    .catch(() => undefined);
});

window.addEventListener('pagehide', () => closePlayer(false));

/* -------------------------------------------------------------------- boot */

async function init() {
  await requestPersistence().catch(() => {});
  await migrateLegacyRecordings().catch(() => {});
  await refresh();
  const id = new URLSearchParams(location.search).get('id');
  if (id) await openRecording(id);
}

init().catch((err) => console.error('[Omnipotent library]', err));
