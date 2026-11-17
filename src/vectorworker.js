// Draws the vector base map (vectormap.js) off the main thread: converting the Natural Earth file and drawing
// thousands of polygons into a large canvas takes seconds, which would freeze the view. The file is fetched here
// (the browser has it cached from the vector borders) and converted once. Messages in: { id, url, bbox, pole
// ({ lon0, oLatP } of a rotated pole grid, or null), width, height }; out: { id, bitmap } (an ImageBitmap,
// flipped vertically as WebGL textures from bitmaps need) or { id, error }.
import * as topojson from 'topojson-client';
import { drawVectorMap, landPolygons, gridProjection } from './vectormap.js';
import { makeRotatedPole } from './rotpole.js';

const data = new Map(); // url → promise of { land, borders }

function vectorData(url) {
  if (!data.has(url)) {
    data.set(url, fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
        return r.json();
      })
      .then((topo) => ({ land: landPolygons(topojson, topo), borders: topojson.mesh(topo, topo.objects.countries).coordinates })));
    data.get(url).catch(() => data.delete(url)); // try again next time
  }
  return data.get(url);
}

self.addEventListener('message', async ({ data: m }) => {
  try {
    const { land, borders } = await vectorData(m.url);
    const proj = m.pole ? makeRotatedPole(m.pole) : null;
    const canvas = drawVectorMap({ land, borders, width: m.width, height: m.height, ...gridProjection(m.bbox, proj, m.width, m.height) });
    const bitmap = await createImageBitmap(canvas, { imageOrientation: 'flipY' });
    self.postMessage({ id: m.id, bitmap }, [bitmap]);
  } catch (e) {
    self.postMessage({ id: m.id, error: e.message });
  }
});
