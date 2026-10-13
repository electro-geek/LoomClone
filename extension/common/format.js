// Tiny formatting helpers shared by the popup, control bar and library.

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(timestamp) {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Elapsed recording time, excluding paused stretches. */
export function elapsedFrom(state, now = Date.now()) {
  if (!state?.startedAt) return 0;
  const pausedTotal = state.pausedTotalMs + (state.pausedAt ? now - state.pausedAt : 0);
  return Math.max(0, now - state.startedAt - pausedTotal);
}

/** Filesystem-safe file name for a recording. */
export function safeFilename(title, ext) {
  const base = (title || 'recording')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${base || 'recording'}.${ext || 'webm'}`;
}
