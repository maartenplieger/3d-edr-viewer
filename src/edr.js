// Minimal OGC API - EDR / CoverageJSON client.

// Reads the body in chunks so onBytes(loaded, total) can report download progress.
async function readJSON(r, onBytes) {
  if (!onBytes || !r.body) return r.json();
  const total = Number(r.headers.get('Content-Length')) || 0;
  const reader = r.body.getReader();
  const chunks = [];
  let loaded = 0;
  onBytes(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onBytes(loaded, total >= loaded ? total : 0); // total is unusable if the body was compressed
  }
  const buf = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder().decode(buf));
}

export async function fetchJSON(url, { signal, retries = 2, onBytes } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { signal });
      if (!r.ok) {
        let msg = `HTTP ${r.status} ${r.statusText}`;
        try {
          const j = await r.json();
          if (j.description) msg += `: ${j.description}`;
        } catch { /* body is not JSON */ }
        const err = new Error(msg);
        err.status = r.status;
        throw err;
      }
      return await readJSON(r, onBytes);
    } catch (e) {
      if (e.name === 'AbortError' || (e.status >= 400 && e.status < 500)) throw e;
      lastErr = e;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export const toIso = (t) => new Date(t).toISOString().replace('.000Z', 'Z');

function parseDuration(s) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s);
  if (!m) return 3600e3;
  return ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) * 1000;
}

// Expands EDR temporal "values" such as "R60/2026-11-05T19:00:00Z/PT1H" into ISO timestamps.
export function parseTemporalValues(values = []) {
  const out = [];
  for (const v of values) {
    const m = /^R(\d+)\/([^/]+)\/(P[^/]+)$/.exec(v);
    if (m) {
      const n = +m[1], start = Date.parse(m[2]), step = parseDuration(m[3]);
      for (let i = 0; i < n; i++) out.push(toIso(start + i * step));
    } else if (!v.includes('/') && !Number.isNaN(Date.parse(v))) {
      out.push(toIso(Date.parse(v)));
    }
  }
  return out;
}

function parseZ(z) {
  const v = z.includes('/') ? z.split('/').map(Number) : z.split(',').map(Number);
  return [Math.min(...v), Math.max(...v)];
}

// Splits ".../collections/{id}[/instances/{id}]/cube?..." into its parts.
export function parseCubeUrl(str) {
  const u = new URL(str.trim());
  const m = /^(.*\/collections\/[^/]+)(?:\/instances\/([^/]+))?\/cube\/?$/.exec(u.origin + u.pathname);
  if (!m) throw new Error('Not an EDR cube URL (…/collections/{id}[/instances/{id}]/cube)');
  const p = u.searchParams;
  const out = { collectionUrl: m[1], instance: m[2] ? decodeURIComponent(m[2]) : '' };
  if (p.get('bbox')) out.bbox = p.get('bbox').split(',').map(Number);
  if (p.get('datetime')) out.datetime = p.get('datetime');
  if (p.get('parameter-name')) out.parameter = p.get('parameter-name').split(',')[0];
  if (p.get('z')) out.levels = parseZ(p.get('z'));
  return out;
}

export function buildCubeUrl({ collectionUrl, instance, bbox, datetime, params, z }) {
  const base = collectionUrl.replace(/\/+$/, '') +
    (instance ? `/instances/${encodeURIComponent(instance)}` : '') + '/cube';
  const q = [`bbox=${bbox.join(',')}`, `z=${z}`];
  if (datetime) q.push(`datetime=${datetime}`);
  q.push(`parameter-name=${params.join(',')}`);
  return `${base}?${q.join('&')}`;
}

function coveragesOf(json) {
  if (json.type === 'CoverageCollection') {
    return json.coverages.map((c) => ({ domain: c.domain || json.domain, ranges: c.ranges }));
  }
  return [{ domain: json.domain, ranges: json.ranges }];
}

function axisValues(ax) {
  if (!ax) return null;
  if (ax.values) return ax.values;
  if (ax.num != null) {
    const n = ax.num;
    return Array.from({ length: n }, (_, i) => (n === 1 ? ax.start : ax.start + (i * (ax.stop - ax.start)) / (n - 1)));
  }
  return null;
}

// Calls fn(zIndex, yIndex, xIndex, value, flatIndex) for every cell of an NdArray range (first time step only).
function forEachValue(range, fn) {
  const names = range.axisNames, shape = range.shape;
  const stride = {};
  let s = 1;
  for (let i = names.length - 1; i >= 0; i--) {
    stride[names[i]] = s;
    s *= shape[i];
  }
  const size = (n) => (names.includes(n) ? shape[names.indexOf(n)] : 1);
  const nz = size('z'), ny = size('y'), nx = size('x');
  const sz = stride.z ?? 0, sy = stride.y ?? 0, sx = stride.x ?? 0;
  const v = range.values;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const idx = k * sz + j * sy + i * sx;
        const val = v[idx];
        fn(k, j, i, val == null ? NaN : val, idx);
      }
}

const isFrac = (v) => Math.abs(v - Math.round(v)) > 1e-3;

const FILL_VALUE = -9999; // returned outside the model domain

// Undoes the KNMI ×10 bug in one response, in place: in multi-level responses every level after
// the first comes back multiplied by 10 (whole numbers only). Returns true when values changed.
function fixScaleBug(json, mode) {
  if (mode === 'off') return false;
  let fixed = false;
  for (const cov of coveragesOf(json)) {
    for (const range of Object.values(cov.ranges)) {
      const zi = range.axisNames.indexOf('z');
      if (zi < 0 || range.shape[zi] < 2) continue;
      if (mode === 'auto') {
        let firstFrac = false, restFrac = false;
        forEachValue(range, (k, j, i, v) => {
          if (v > FILL_VALUE && isFrac(v)) k === 0 ? (firstFrac = true) : (restFrac = true);
        });
        if (!firstFrac || restFrac) continue;
      }
      const v = range.values;
      forEachValue(range, (k, j, i, val, idx) => {
        if (k > 0 && v[idx] != null && v[idx] > FILL_VALUE) v[idx] /= 10; // fill values are not scaled
      });
      fixed = true;
    }
  }
  return fixed;
}

const MAX_POINTS_PER_LEVEL = 100000; // 'auto' horizontal step keeps levels below this size

/**
 * Loads a 3D cube into a regular grid with lon/lat ascending and levels ascending.
 * data[param][(k * ny + j) * nx + i]
 *
 * `stride` ('auto' or n) averages n×n blocks of server grid points while ingesting, so large
 * areas such as the full model domain stay manageable.
 * Levels are fetched in chunks of `levelsPerRequest` (z=a/b), `concurrency` requests at a time.
 * fixScale ('auto' | 'on' | 'off') controls the per-response ×10 correction, see fixScaleBug.
 */
export async function loadCube(o, { signal, onProgress, onUrl } = {}) {
  const levels = [];
  for (let l = o.levelFrom; l <= o.levelTo; l++) levels.push(l);
  const levelIndex = new Map(levels.map((l, k) => [l, k]));
  const params = [...new Set(o.params)];
  let grid = null;

  // Maps source indices (server order) to averaged, ascending block indices; -1 = dropped edge.
  const blockAxis = (vals, stride) => {
    const n = vals.length, rev = vals[0] > vals[n - 1];
    const sorted = rev ? [...vals].reverse() : vals;
    const nb = Math.max(1, Math.floor(n / stride));
    const centers = Array.from({ length: nb }, (_, b) => {
      let s = 0, c = 0;
      for (let i = b * stride; i < Math.min(n, (b + 1) * stride); i++) { s += sorted[i]; c++; }
      return s / c;
    });
    const map = Int32Array.from({ length: n }, (_, i) => {
      const b = Math.floor((rev ? n - 1 - i : i) / stride);
      return b < nb ? b : -1;
    });
    return { centers, map };
  };

  const ensureGrid = (domain) => {
    if (grid) return;
    const xs = axisValues(domain.axes.x).map(Number);
    const ys = axisValues(domain.axes.y).map(Number);
    const stride = o.stride && o.stride !== 'auto' ? Math.max(1, Math.round(o.stride))
      : Math.max(1, Math.ceil(Math.sqrt((xs.length * ys.length) / MAX_POINTS_PER_LEVEL)));
    const bx = blockAxis(xs, stride), by = blockAxis(ys, stride);
    const nx = bx.centers.length, ny = by.centers.length, nz = levels.length;
    grid = {
      nx, ny, nz, levels, stride,
      sourceSize: [xs.length, ys.length],
      lons: bx.centers,
      lats: by.centers,
      imap: bx.map,
      jmap: by.map,
      sum: Object.fromEntries(params.map((p) => [p, new Float32Array(nx * ny * nz)])),
      count: Object.fromEntries(params.map((p) => [p, new Uint8Array(nx * ny * nz)])),
    };
  };

  const ingest = (json, fallbackLevel) => {
    for (const cov of coveragesOf(json)) {
      ensureGrid(cov.domain);
      const zv = axisValues(cov.domain.axes.z) ?? [fallbackLevel];
      const { nx, ny, imap, jmap } = grid;
      for (const [name, range] of Object.entries(cov.ranges)) {
        const sum = grid.sum[name], count = grid.count[name];
        if (!sum) continue;
        forEachValue(range, (kc, j, i, val) => {
          const k = levelIndex.get(Number(zv[kc]));
          const ti = imap[i], tj = jmap[j];
          if (k === undefined || ti < 0 || tj < 0 || val !== val || val <= FILL_VALUE) return;
          const idx = (k * ny + tj) * nx + ti;
          sum[idx] += val;
          count[idx]++;
        });
      }
    }
  };

  const size = Math.max(1, Math.round(o.levelsPerRequest) || levels.length);
  const chunks = [];
  for (let n = 0; n < levels.length; n += size) chunks.push(levels.slice(n, n + size));
  const req = (c) => buildCubeUrl({ ...o, params, z: c.length === 1 ? `${c[0]}` : `${c[0]}/${c.at(-1)}` });
  let fixedResponses = 0;
  const handle = (json, c) => {
    if (fixScaleBug(json, o.fixScale)) fixedResponses++;
    ingest(json, c[0]);
  };
  onUrl?.(req(chunks[0]));

  if (chunks.length === 1) {
    onProgress?.({ phase: 'waiting' });
    const json = await fetchJSON(req(chunks[0]), {
      signal,
      onBytes: (loaded, total) => onProgress?.({ phase: 'downloading', done: loaded, total }),
    });
    onProgress?.({ phase: 'parsing' });
    handle(json, chunks[0]);
  } else {
    const inner = new AbortController();
    const onAbort = () => inner.abort();
    signal?.addEventListener('abort', onAbort);
    let next = 0, done = 0, requestsDone = 0;
    const progress = () => onProgress?.({
      phase: 'levels', done, total: levels.length, requestsDone, requests: chunks.length,
    });
    progress();
    const worker = async () => {
      while (next < chunks.length) {
        const c = chunks[next++];
        handle(await fetchJSON(req(c), { signal: inner.signal }), c);
        done += c.length;
        requestsDone++;
        progress();
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(o.concurrency || 6, chunks.length) }, worker));
    } catch (e) {
      inner.abort();
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }
  if (!grid) throw new Error('No data returned');
  grid.data = {};
  for (const p of params) {
    const sum = grid.sum[p], count = grid.count[p];
    grid.data[p] = sum.map((s, n) => (count[n] ? s / count[n] : NaN));
  }
  delete grid.sum;
  delete grid.count;
  grid.requests = chunks.length;
  grid.scaleFixed = fixedResponses;
  return grid;
}
