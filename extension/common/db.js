// IndexedDB layer. This is the whole "backend" — recordings live in the
// extension origin's own database on disk, nothing is ever uploaded.
//
// Two stores:
//   chunks     — one row per MediaRecorder dataavailable event, key [recordingId, seq].
//                Keeps memory flat on long recordings and survives a crash.
//   recordings — the finished file plus metadata, key id.

const DB_NAME = 'omnipotent';
const LEGACY_DB_NAME = 'loomclone'; // pre-rename database
const DB_VERSION = 1;
export const STORE_CHUNKS = 'chunks';
export const STORE_RECORDINGS = 'recordings';

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_CHUNKS)) {
        const chunks = db.createObjectStore(STORE_CHUNKS, {
          keyPath: ['recordingId', 'seq'],
        });
        chunks.createIndex('byRecording', 'recordingId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) {
        const recs = db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' });
        recs.createIndex('byCreatedAt', 'createdAt', { unique: false });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        dbPromise = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/* ------------------------------------------------------------------ chunks */

export async function appendChunk(recordingId, seq, blob) {
  const db = await openDb();
  const t = db.transaction(STORE_CHUNKS, 'readwrite');
  t.objectStore(STORE_CHUNKS).put({ recordingId, seq, blob });
  await done(t);
}

export async function getChunkBlobs(recordingId) {
  const db = await openDb();
  const store = tx(db, STORE_CHUNKS, 'readonly');
  const range = IDBKeyRange.bound([recordingId, -Infinity], [recordingId, Infinity]);
  const rows = await wrap(store.getAll(range));
  // Primary keys are already ordered by [recordingId, seq], but sort defensively.
  rows.sort((a, b) => a.seq - b.seq);
  return rows.map((r) => r.blob);
}

export async function deleteChunks(recordingId) {
  const db = await openDb();
  const t = db.transaction(STORE_CHUNKS, 'readwrite');
  const range = IDBKeyRange.bound([recordingId, -Infinity], [recordingId, Infinity]);
  t.objectStore(STORE_CHUNKS).delete(range);
  await done(t);
}

/** Distinct recordingIds that still have chunks — i.e. sessions that never finalized. */
export async function orphanChunkIds() {
  const db = await openDb();
  const index = tx(db, STORE_CHUNKS, 'readonly').index('byRecording');
  const ids = [];
  await new Promise((resolve, reject) => {
    // 'nextunique' stops once per distinct recordingId instead of once per chunk.
    const req = index.openKeyCursor(null, 'nextunique');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve();
      ids.push(cursor.key);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
  return ids;
}

/* -------------------------------------------------------------- recordings */

export async function putRecording(record) {
  const db = await openDb();
  const t = db.transaction(STORE_RECORDINGS, 'readwrite');
  t.objectStore(STORE_RECORDINGS).put(record);
  await done(t);
}

export async function getRecording(id) {
  const db = await openDb();
  return wrap(tx(db, STORE_RECORDINGS, 'readonly').get(id));
}

/** Newest first. Pass { withBlob: false } to keep the list view light. */
export async function listRecordings({ withBlob = false } = {}) {
  const db = await openDb();
  const rows = await wrap(tx(db, STORE_RECORDINGS, 'readonly').getAll());
  rows.sort((a, b) => b.createdAt - a.createdAt);
  if (withBlob) return rows;
  return rows.map(({ blob, ...meta }) => meta);
}

export async function deleteRecording(id) {
  const db = await openDb();
  const t = db.transaction(STORE_RECORDINGS, 'readwrite');
  t.objectStore(STORE_RECORDINGS).delete(id);
  await done(t);
  await deleteChunks(id);
}

export async function renameRecording(id, title) {
  const record = await getRecording(id);
  if (!record) return null;
  record.title = title;
  await putRecording(record);
  return record;
}

/** Stitch a session's stored chunks back into one file. */
export async function assembleBlob(recordingId, mimeType) {
  const blobs = await getChunkBlobs(recordingId);
  if (!blobs.length) return null;
  return new Blob(blobs, { type: mimeType });
}

/**
 * Store the finished file and drop the now-redundant chunks.
 * Returns the metadata without the blob (safe to pass through messaging).
 */
export async function commitRecording(recordingId, blob, meta) {
  const record = {
    id: recordingId,
    title: meta.title,
    createdAt: meta.createdAt,
    durationMs: meta.durationMs,
    mimeType: meta.mimeType,
    ext: meta.ext,
    width: meta.width ?? null,
    height: meta.height ?? null,
    hasMic: !!meta.hasMic,
    hasCamera: !!meta.hasCamera,
    hasTabAudio: !!meta.hasTabAudio,
    thumbnail: meta.thumbnail ?? null,
    size: blob.size,
    blob,
  };
  await putRecording(record);
  await deleteChunks(recordingId);
  const { blob: _omit, ...metaOnly } = record;
  return metaOnly;
}

/* ------------------------------------------------------------------- misc */

export async function storageEstimate() {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}

/** Ask Chrome not to evict our recordings when the disk gets tight. */
export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

/**
 * Carry recordings over from the pre-rename database, once.
 *
 * The rename to Omnipotent changed the database name, which would otherwise leave
 * older recordings stranded on disk but invisible in the library. This copies them
 * across and drops the old database. Safe to call on every startup: it returns
 * immediately when there is nothing to move.
 *
 * @returns {Promise<number>} how many recordings were migrated
 */
export async function migrateLegacyRecordings() {
  if (!indexedDB.databases) return 0;
  const names = (await indexedDB.databases().catch(() => [])).map((d) => d.name);
  if (!names.includes(LEGACY_DB_NAME)) return 0;

  const legacy = await new Promise((resolve) => {
    const req = indexedDB.open(LEGACY_DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // A fresh upgrade means the old database never really existed — nothing to take.
    req.onupgradeneeded = () => {
      req.transaction.abort();
      resolve(null);
    };
  });

  let moved = 0;
  if (legacy) {
    if (legacy.objectStoreNames.contains(STORE_RECORDINGS)) {
      const rows = await wrap(
        legacy.transaction(STORE_RECORDINGS, 'readonly').objectStore(STORE_RECORDINGS).getAll(),
      ).catch(() => []);
      for (const row of rows) {
        await putRecording(row).catch(() => {});
        moved += 1;
      }
    }
    legacy.close();
  }

  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(LEGACY_DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  return moved;
}

export function newRecordingId() {
  return `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
