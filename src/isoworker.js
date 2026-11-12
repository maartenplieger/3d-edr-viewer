// Computes isosurfaces off the main thread, so sliders stay smooth on large grids.
// Messages in:  { type: 'field', key, field, nx, ny, nz, px, py, pz }  the grid, sent once per grid and parameter
//               { type: 'build', id, key, value }                      a surface for the field with this key
// Messages out: { id, key, value, positions, normals, indices, ijk, ms }  (buffers transferred), or { id, error }
import { marchingCubes } from './isosurface.js';

let grid = null;

self.onmessage = ({ data }) => {
  if (data.type === 'field') {
    grid = data;
    return;
  }
  if (data.type !== 'build') return;
  if (!grid || grid.key !== data.key) {
    self.postMessage({ id: data.id, error: 'field not loaded' });
    return;
  }
  try {
    const t0 = performance.now();
    const r = marchingCubes(grid.field, grid.nx, grid.ny, grid.nz, data.value, grid.px, grid.py, grid.pz);
    const ms = performance.now() - t0;
    self.postMessage(
      { id: data.id, key: data.key, value: data.value, ms, ...r },
      [r.positions.buffer, r.normals.buffer, r.indices.buffer, r.ijk.buffer],
    );
  } catch (e) {
    self.postMessage({ id: data.id, error: String(e) });
  }
};
