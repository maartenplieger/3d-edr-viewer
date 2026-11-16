// Loaded cubes kept in the browser (IndexedDB) across sessions, decoded: as the grid the viewer uses, so a time
// loaded before is there again in a fraction of a second, without the server, downloading or parsing. Only for
// the times of a run (an instance), whose data does not change. The least recently used are dropped first when
// the store grows beyond its limit. Used by the cube workers; the panel reads the usage and can clear it.
const DB_NAME = 'edr3d-frames';
const VERSION = 1;
export const KEY_PREFIX = 'v1|'; // a new grid format gets a new prefix, so old entries are not used

let dbPromise = null;
export function openFrames() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      db.createObjectStore('grids'); // key → grid
      db.createObjectStore('meta', { keyPath: 'key' }).createIndex('used', 'used'); // { key, bytes, used }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  dbPromise.catch(() => (dbPromise = null)); // try again next time
  return dbPromise;
}

const request = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const finished = (tx) => new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });

// The stored grid for key, or null; marks it as used now
export async function getFrame(key) {
  const db = await openFrames();
  const tx = db.transaction(['grids', 'meta'], 'readwrite');
  const grid = await request(tx.objectStore('grids').get(KEY_PREFIX + key));
  if (grid) {
    const meta = await request(tx.objectStore('meta').get(KEY_PREFIX + key));
    if (meta) tx.objectStore('meta').put({ ...meta, used: Date.now() });
  }
  await finished(tx);
  return grid ?? null;
}

// Stores grid under key. The grid is copied right away (before this returns), so its arrays can be transferred
// afterwards; the promise resolves when it is written and older entries beyond limit (bytes) are dropped.
export function putFrame(db, key, grid, bytes, limit) {
  const tx = db.transaction(['grids', 'meta'], 'readwrite');
  tx.objectStore('grids').put(grid, KEY_PREFIX + key);
  tx.objectStore('meta').put({ key: KEY_PREFIX + key, bytes, used: Date.now() });
  return finished(tx).then(() => evictFrames(limit));
}

// Drops the least recently used entries until the store is within limit (bytes); returns the usage
export async function evictFrames(limit) {
  const db = await openFrames();
  const tx = db.transaction(['grids', 'meta'], 'readwrite');
  const metas = await request(tx.objectStore('meta').index('used').getAll()); // oldest first
  let bytes = metas.reduce((sum, m) => sum + m.bytes, 0), count = metas.length;
  for (const m of metas) {
    if (bytes <= limit) break;
    tx.objectStore('grids').delete(m.key);
    tx.objectStore('meta').delete(m.key);
    bytes -= m.bytes;
    count--;
  }
  await finished(tx);
  return { count, bytes };
}

// { count, bytes, keys: Set of the stored request keys }
export async function frameStoreUsage() {
  const db = await openFrames();
  const metas = await request(db.transaction('meta').objectStore('meta').getAll());
  const keys = new Set(metas.filter((m) => m.key.startsWith(KEY_PREFIX)).map((m) => m.key.slice(KEY_PREFIX.length)));
  return { count: metas.length, bytes: metas.reduce((sum, m) => sum + m.bytes, 0), keys };
}

export async function clearFrames() {
  const db = await openFrames();
  const tx = db.transaction(['grids', 'meta'], 'readwrite');
  tx.objectStore('grids').clear();
  tx.objectStore('meta').clear();
  await finished(tx);
}
