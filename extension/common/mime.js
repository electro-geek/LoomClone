// Container/codec negotiation.
//
// MP4 first: Chrome 130+ can record H.264/AAC directly, which sidesteps the classic
// WebM problem where MediaRecorder writes no duration into the header and the file
// won't seek. WebM stays as the fallback (and library.js patches its duration at
// playback time).

const CANDIDATES = [
  { mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: 'mp4' },
  { mimeType: 'video/mp4;codecs="avc1.4D401F,mp4a.40.2"', ext: 'mp4' },
  { mimeType: 'video/mp4', ext: 'mp4' },
  { mimeType: 'video/webm;codecs=vp9,opus', ext: 'webm' },
  { mimeType: 'video/webm;codecs=vp8,opus', ext: 'webm' },
  { mimeType: 'video/webm', ext: 'webm' },
];

/**
 * @param {'mp4'|'webm'} preference
 * @returns {{mimeType: string, ext: string}}
 */
export function pickMimeType(preference = 'mp4') {
  const supported = CANDIDATES.filter(
    (c) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c.mimeType),
  );
  const preferred = supported.find((c) => c.ext === preference);
  if (preferred) return preferred;
  if (supported.length) return supported[0];
  // Last resort: let the browser choose its own default.
  return { mimeType: '', ext: 'webm' };
}

/** What this Chrome build can actually record, for display in the popup. */
export function availableFormats() {
  const seen = new Set();
  return CANDIDATES.filter((c) => {
    if (seen.has(c.ext)) return false;
    if (typeof MediaRecorder === 'undefined') return false;
    if (!MediaRecorder.isTypeSupported(c.mimeType)) return false;
    seen.add(c.ext);
    return true;
  }).map((c) => c.ext);
}
