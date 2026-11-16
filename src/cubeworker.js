// Loads cubes off the main thread: downloading, parsing the CoverageJSON and averaging the grid points (see
// edr.js loadCube) take up to seconds per time, which would make the view stutter while an animation loads the
// next times. Loaded cubes of a run are also kept in the local store (framestore.js) and taken from there next
// time. Messages in: { type: 'load', id, opts, key, store: { limit (bytes, 0 = off) } } and
// { type: 'abort', id }. Messages out: { id, type: 'url' | 'progress' | 'done' | 'error' }; the grid's arrays are
// transferred, not copied.
import { loadCube } from './edr.js';
import { openFrames, getFrame, putFrame } from './framestore.js';

const jobs = new Map(); // id → AbortController

const send = (id, grid) => self.postMessage({ id, type: 'done', grid }, Object.values(grid.data).map((a) => a.buffer));

self.addEventListener('message', async ({ data: m }) => {
  if (m.type === 'abort') {
    jobs.get(m.id)?.abort();
    return;
  }
  if (m.type !== 'load') return;
  const ac = new AbortController();
  jobs.set(m.id, ac);
  // Only the times of a run are stored: without an instance the data behind the same request can change
  const storable = m.store?.limit > 0 && m.key && m.opts.instance;
  try {
    if (storable) {
      const stored = await getFrame(m.key).catch((e) => { console.warn('Local store not readable', e); return null; });
      if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (stored) {
        stored.fromStore = true;
        send(m.id, stored);
        return;
      }
    }
    const grid = await loadCube(m.opts, {
      signal: ac.signal,
      onUrl: (url) => self.postMessage({ id: m.id, type: 'url', url }),
      onProgress: (progress) => self.postMessage({ id: m.id, type: 'progress', progress }),
    });
    delete grid.imap; // only used while averaging
    delete grid.jmap;
    if (storable) {
      try {
        const db = await openFrames();
        const bytes = Object.values(grid.data).reduce((sum, a) => sum + a.byteLength, 0);
        // Copied into the store before the arrays are transferred below
        putFrame(db, m.key, grid, bytes, m.store.limit).catch((e) => console.warn('Could not store the cube locally', e));
      } catch (e) {
        console.warn('Local store not available', e);
      }
    }
    send(m.id, grid);
  } catch (e) {
    self.postMessage({ id: m.id, type: 'error', error: { name: e.name, message: e.message, status: e.status } });
  } finally {
    jobs.delete(m.id);
  }
});
