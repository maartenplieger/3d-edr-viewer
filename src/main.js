import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as topojson from 'topojson-client';
import { fetchJSON, parseTemporalValues, parseCubeUrl, toIso, loadCube } from './edr.js';
import { marchingCubes } from './isosurface.js';
import { COLORMAP_NAMES, makeColormapTexture, drawColorbar, hexToRgb } from './colormaps.js';
import { resampleVolume, createVolumeMaterial, createVolumeTexture, updateVolumeCamera } from './volume.js';

const DEFAULT_URL =
  'https://geoservices.knmi.nl/edr/collections/uwcw-ha-det-dini-5p5km.ml/instances/202611051800/cube' +
  '?bbox=3,50.7,7.3,53.6&z=10/90&datetime=2026-11-05T21:00:00Z&parameter-name=wind_speed_ml';
const WMS_URL = 'https://geoservices.knmi.nl/wms?DATASET=baselayers&';
const BORDERS_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-10m.json';
const PRESSURE_PARAM = 'air_pressure_ml';

// One-click views. bbox: 'full' = model domain extent, or [W, S, E, N]; levels: 'all' or [from, to];
// stride: horizontal step ('auto' or 1–4);
// threshold sets the first isosurface value (also the volume's fill threshold).
const PRESETS = [
  {
    name: 'Jet stream – full domain',
    description: 'Wind speed, all levels, 4×4 averaged, volume filled above 50 kt, vertical scale ×10',
    bbox: 'full',
    stride: '4', // horizontal step: 'auto' or 1–4
    parameter: 'wind_speed_ml',
    levels: 'all',
    renderMode: 'volume',
    volStyle: '0', // 0 = fill above, 1 = fill below, 2 = band
    threshold: 50,
    vscale: 10,
  },
];
const KM_SCALE = 5; // world units per km of altitude in pressure-altitude mode
const MAX_ISO_LINES = 4;

const $ = (id) => document.getElementById(id);

const state = {
  collection: null,
  instances: [],
  grid: null, // loaded cube, see edr.js loadCube
  geo: null, // world coordinates derived from grid
  isos: [],
  borders: null, // [[ [lon, lat], ... ], ...]
  abort: null,
  volume: null, // { mesh, tex }
  mapTex: null, // { url, promise, tex } cached WMS base map texture
};

// ---------------------------------------------------------------- scene

const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f1419);
const camera = new THREE.PerspectiveCamera(45, 1, 1, 10000);
camera.up.set(0, 0, 1);
camera.position.set(-150, -450, 300);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0xdde8ff, 0x2a3440, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-1, -1.5, 3);
scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.5);
fill.position.set(1, 1.5, -1);
scene.add(fill);

// Everything in dataGroup is in "unscaled" world units; its z scale is the vertical scale.
const dataGroup = new THREE.Group();
const isoGroup = new THREE.Group();
const sliceGroup = new THREE.Group();
const mapGroup = new THREE.Group();
const boxGroup = new THREE.Group();
const volumeGroup = new THREE.Group();
const groundGroup = new THREE.Group();
dataGroup.add(isoGroup, sliceGroup, mapGroup, boxGroup, volumeGroup, groundGroup);
const labelGroup = new THREE.Group(); // kept unscaled so text is not stretched
scene.add(dataGroup, labelGroup);

const sliceUniforms = {
  cmap: { value: makeColormapTexture('turbo') },
  vmin: { value: 0 },
  vmax: { value: 1 },
  opacity: { value: 0.9 },
  interval: { value: 2 },
  showContours: { value: 1 },
  isoCount: { value: 0 },
  isoValues: { value: new Array(MAX_ISO_LINES).fill(0) },
  isoColors: { value: Array.from({ length: MAX_ISO_LINES }, () => new THREE.Vector3(1, 1, 1)) },
};

const sliceMaterial = new THREE.ShaderMaterial({
  uniforms: { ...sliceUniforms, ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog) },
  fog: true,
  side: THREE.DoubleSide,
  transparent: true,
  vertexShader: /* glsl */ `
    attribute float value;
    varying float vValue;
    #include <fog_pars_vertex>
    void main() {
      vValue = value;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D cmap;
    uniform float vmin, vmax, opacity, interval, showContours, isoCount;
    uniform float isoValues[${MAX_ISO_LINES}];
    uniform vec3 isoColors[${MAX_ISO_LINES}];
    varying float vValue;
    #include <fog_pars_fragment>
    void main() {
      if (vValue < -1e29) discard;
      float t = clamp((vValue - vmin) / max(vmax - vmin, 1e-6), 0.0, 1.0);
      vec3 c = texture2D(cmap, vec2(t, 0.5)).rgb;
      float fw = max(fwidth(vValue), 1e-6);
      if (showContours > 0.5 && interval > 0.0) {
        float f = vValue / interval;
        float d = abs(fract(f + 0.5) - 0.5) / max(fwidth(f), 1e-6);
        c = mix(c, vec3(0.05), (1.0 - smoothstep(0.0, 1.0, d)) * 0.5);
      }
      for (int n = 0; n < ${MAX_ISO_LINES}; n++) {
        if (float(n) >= isoCount) break;
        float d = abs(vValue - isoValues[n]) / fw;
        c = mix(c, vec3(0.0), 1.0 - smoothstep(1.5, 2.5, d));
        c = mix(c, isoColors[n], 1.0 - smoothstep(0.5, 1.5, d));
      }
      #ifdef USE_FOG
        // Output is not colour-managed here, so fade towards the sRGB haze colour.
        c = mix(c, pow(fogColor, vec3(1.0 / 2.2)), smoothstep(fogNear, fogFar, vFogDepth));
      #endif
      gl_FragColor = vec4(c, opacity);
    }`,
});

const volumeMaterial = createVolumeMaterial({
  cmap: sliceUniforms.cmap,
  vmin: sliceUniforms.vmin,
  vmax: sliceUniforms.vmax,
  isoValues: sliceUniforms.isoValues,
  isoColors: sliceUniforms.isoColors,
});
const volumeUniforms = volumeMaterial.uniforms;
const isoDepthMaterial = new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide });

new ResizeObserver(() => {
  const { clientWidth: w, clientHeight: h } = $('view');
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}).observe($('view'));

let pickPending = false;
const pointer = new THREE.Vector2();
// Depth haze: linear fog fitted to the scene every frame, so it starts at the front of the data
// and reaches the chosen strength (roughly) at the back, whatever the zoom level.
const haze = new THREE.Fog(0x4a5a6a, 1, 2);
const tmpBox = new THREE.Box3();
const tmpSphere = new THREE.Sphere();

function updateHaze() {
  scene.fog = $('hazeOn').checked && state.geo ? haze : null;
  if (!scene.fog) return;
  const { px, py, zmin, zmax } = state.geo;
  const s = vscale();
  tmpBox.min.set(px[0], py[0], zmin * s);
  tmpBox.max.set(px.at(-1), py.at(-1), zmax * s);
  tmpBox.getBoundingSphere(tmpSphere);
  const d = camera.position.distanceTo(tmpSphere.center);
  const strength = Number($('hazeAmount').value);
  haze.near = Math.max(0, d - tmpSphere.radius);
  haze.far = haze.near + (2 * tmpSphere.radius) / Math.max(strength, 0.01);
}

renderer.setAnimationLoop(() => {
  controls.update();
  updateHaze();
  if (state.volume && volumeGroup.visible) updateVolumeCamera(state.volume.mesh, camera);
  if (pickPending) {
    pickPending = false;
    pick();
  }
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------- helpers

const fmt = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '–');

function setStatus(msg, isError = false) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', isError);
}

function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

const vscale = () => 10 ** Number($('vscale').value);

function paramUnit(id) {
  const u = state.collection?.parameter_names?.[id]?.unit?.symbol;
  const s = typeof u === 'string' ? u : u?.value;
  return s === 'C' ? '°C' : s && s !== 'unknown' ? s : '';
}

// Pressure (hPa) → ISA altitude (km), tropospheric + isothermal stratospheric layer.
function isaAltitudeKm(p) {
  if (p >= 226.32) return 44.3308 * (1 - (p / 1013.25) ** 0.190263);
  return 11 + 6.3416 * Math.log(226.32 / p);
}

const lerpArr = (arr, f) => {
  const i = Math.max(0, Math.min(arr.length - 1, Math.floor(f)));
  const n = Math.min(arr.length - 1, i + 1);
  return arr[i] + (arr[n] - arr[i]) * (f - i);
};

function sampleField(field, fi, fj, fk) {
  const { nx, ny, nz } = state.grid;
  const i0 = Math.max(0, Math.min(nx - 2, Math.floor(fi))), j0 = Math.max(0, Math.min(ny - 2, Math.floor(fj)));
  const k0 = Math.max(0, Math.min(nz - 2, Math.floor(fk)));
  const tx = fi - i0, ty = fj - j0, tz = nz > 1 ? fk - k0 : 0;
  let v = 0;
  for (let c = 0; c < 8; c++) {
    const di = c & 1, dj = (c >> 1) & 1, dk = (c >> 2) & 1;
    const k = Math.min(nz - 1, k0 + dk);
    const w = (di ? tx : 1 - tx) * (dj ? ty : 1 - ty) * (dk ? tz : 1 - tz);
    if (w) v += w * field[(k * ny + j0 + dj) * nx + i0 + di];
  }
  return v;
}

function disposeChildren(group) {
  for (const o of [...group.children]) {
    group.remove(o);
    o.geometry?.dispose();
    if (o.material && o.material !== sliceMaterial) {
      if (o.material.map !== state.mapTex?.tex) o.material.map?.dispose();
      o.material.dispose();
    }
  }
}

// ---------------------------------------------------------------- metadata

async function loadCollection(collectionUrl, prefer = {}) {
  setStatus('Loading collection metadata…');
  const url = collectionUrl.replace(/\/+$/, '');
  state.collection = await fetchJSON(url);
  const sel = $('parameter');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(state.collection.parameter_names || {})) {
    const unit = paramUnit(id);
    sel.append(option(id, `${p.label || id}${unit ? ` [${unit}]` : ''}`));
  }
  if (prefer.parameter && state.collection.parameter_names?.[prefer.parameter]) sel.value = prefer.parameter;

  const vals = (state.collection.extent?.vertical?.values || []).map(Number).filter(Number.isFinite);
  if (vals.length) {
    for (const id of ['levelFrom', 'levelTo']) {
      $(id).min = Math.min(...vals);
      $(id).max = Math.max(...vals);
    }
  }

  const isel = $('instance');
  isel.innerHTML = '';
  state.instances = [];
  try {
    state.instances = (await fetchJSON(`${url}/instances`, { retries: 0 })).instances || [];
  } catch { /* collection without instances */ }
  isel.append(option('', '(collection, no instance)'));
  for (const inst of state.instances) isel.append(option(inst.id, inst.id));
  isel.value = state.instances.some((i) => i.id === prefer.instance) ? prefer.instance : state.instances[0]?.id ?? '';
  if (prefer.instance && isel.value !== prefer.instance) {
    setStatus(`Instance ${prefer.instance} not available, using ${isel.value || 'collection'}`);
  }
  updateDatetimes(prefer.datetime);
}

function updateDatetimes(prefer) {
  const inst = state.instances.find((i) => i.id === $('instance').value);
  const times = parseTemporalValues((inst || state.collection)?.extent?.temporal?.values || []);
  const sel = $('datetime');
  const current = prefer ? toIso(Date.parse(prefer)) : sel.value;
  sel.innerHTML = '';
  for (const t of times) sel.append(option(t, t.replace('T', ' ').replace(':00Z', 'Z')));
  if (times.includes(current)) sel.value = current;
}

// ---------------------------------------------------------------- loading

function readBBox() {
  const b = ['bboxW', 'bboxS', 'bboxE', 'bboxN'].map((id) => Number($(id).value));
  if (b.some((v) => !Number.isFinite(v)) || b[0] >= b[2] || b[1] >= b[3]) throw new Error('Invalid bounding box');
  return b;
}

async function loadData() {
  state.abort?.abort();
  const ac = new AbortController();
  state.abort = ac;
  const param = $('parameter').value;
  const vmode = $('vmode').value;
  const params = vmode === 'pressure' && param !== PRESSURE_PARAM ? [param, PRESSURE_PARAM] : [param];
  let opts;
  try {
    const levelFrom = Math.round(Number($('levelFrom').value)), levelTo = Math.round(Number($('levelTo').value));
    if (!(levelFrom <= levelTo)) throw new Error('Level from must be ≤ level to');
    opts = {
      collectionUrl: $('collectionUrl').value.trim(),
      instance: $('instance').value,
      datetime: $('datetime').value,
      bbox: readBBox(),
      levelFrom, levelTo, params,
      levelsPerRequest: Number($('levelsPerRequest').value) || 5,
      stride: $('stride').value === 'auto' ? 'auto' : Number($('stride').value),
      fixScale: $('fixScale').value,
      concurrency: Number($('concurrency').value) || 6,
    };
  } catch (e) {
    setStatus(e.message, true);
    return;
  }

  $('load').disabled = true;
  $('cancel').disabled = false;
  setStatus(`Requesting levels ${opts.levelFrom}–${opts.levelTo}, ${opts.levelsPerRequest} per request…`);
  const loader = startLoader();
  const t0 = performance.now();
  try {
    const grid = await loadCube(opts, {
      signal: ac.signal,
      onUrl: (u) => { $('requestUrl').href = u; $('requestUrl').textContent = u; },
      onProgress: loader.update,
    });
    Object.assign(grid, { param, vmode, unit: paramUnit(param), datetime: opts.datetime, instance: opts.instance });
    loader.update({ phase: 'building' });
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res)));
    state.grid = grid;
    rebuildAll();
    fitCamera();
    const s = ((performance.now() - t0) / 1000).toFixed(1);
    const step = grid.stride > 1 ? ` (${grid.sourceSize.join('×')} averaged ${grid.stride}×${grid.stride})` : '';
    setStatus(`Loaded ${grid.nx}×${grid.ny}×${grid.nz} points${step} with ${grid.requests} request${grid.requests > 1 ? 's' : ''} in ${s} s` +
      (grid.scaleFixed ? ` (×10 server fix applied to ${grid.scaleFixed} response${grid.scaleFixed > 1 ? 's' : ''})` : ''));
  } catch (e) {
    if (e.name === 'AbortError') setStatus('Cancelled');
    else {
      console.error(e);
      setStatus(e.message, true);
    }
  } finally {
    loader.stop();
    $('load').disabled = false;
    $('cancel').disabled = true;
    if (state.abort === ac) state.abort = null;
  }
}

const fmtBytes = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

// Overlay in the 3D view plus the panel progress bar; update() takes loadCube progress events.
function startLoader() {
  const t0 = performance.now();
  let p = { phase: 'waiting' };
  const render = () => {
    const sec = `${((performance.now() - t0) / 1000).toFixed(1)} s`;
    let title, detail = sec, frac = null;
    switch (p.phase) {
      case 'waiting':
        title = 'Waiting for server…';
        detail = `${sec} · an uncached multi-level cube can take 30–40 s`;
        break;
      case 'downloading':
        title = 'Downloading cube';
        frac = p.total ? p.done / p.total : null;
        detail = `${fmtBytes(p.done)}${p.total ? ` / ${fmtBytes(p.total)}` : ''} · ${sec}`;
        break;
      case 'levels':
        title = `Loading levels ${p.done} / ${p.total}`;
        frac = p.total ? p.done / p.total : null;
        detail = `request ${p.requestsDone} / ${p.requests} done · ${sec}`;
        break;
      case 'parsing':
        title = 'Decoding CoverageJSON…';
        break;
      default:
        title = 'Building 3D scene…';
    }
    $('loadTitle').textContent = title;
    $('loadDetail').textContent = detail;
    $('loadBar').parentElement.classList.toggle('indeterminate', frac === null);
    $('loadBar').style.width = frac === null ? '' : `${(frac * 100).toFixed(1)}%`;
    if (frac === null) $('progress').removeAttribute('value');
    else $('progress').value = frac;
  };
  $('overlay').hidden = false;
  render();
  const timer = setInterval(render, 100);
  return {
    update: (next) => { p = next; render(); },
    stop: () => {
      clearInterval(timer);
      $('overlay').hidden = true;
      $('progress').value = 0;
    },
  };
}

async function applyUrl() {
  try {
    const p = parseCubeUrl($('url').value);
    $('collectionUrl').value = p.collectionUrl;
    if (p.bbox?.length === 4) ['bboxW', 'bboxS', 'bboxE', 'bboxN'].forEach((id, n) => ($(id).value = p.bbox[n]));
    if (p.levels) {
      $('levelFrom').value = p.levels[0];
      $('levelTo').value = p.levels[1];
    }
    await loadCollection(p.collectionUrl, p);
    await loadData();
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  }
}

// ---------------------------------------------------------------- geometry

function computeGeo() {
  const g = state.grid;
  const { nx, ny, nz, lons, lats } = g;
  const lon0 = (lons[0] + lons[nx - 1]) / 2, lat0 = (lats[0] + lats[ny - 1]) / 2;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  const px = Float32Array.from(lons, (l) => (l - lon0) * kx);
  const py = Float32Array.from(lats, (l) => (l - lat0) * ky);
  const ext = Math.max(px[nx - 1] - px[0], py[ny - 1] - py[0]);
  const pz = new Float32Array(nx * ny * nz);
  let levelSpacing = 0;
  if (g.vmode === 'pressure' && g.data[PRESSURE_PARAM]) {
    const p = g.data[PRESSURE_PARAM];
    for (let n = 0; n < pz.length; n++) pz[n] = p[n] > 0 ? isaAltitudeKm(p[n]) * KM_SCALE : NaN;
    // Fill missing pressures with the level mean so geometry stays intact.
    const layer = nx * ny;
    for (let k = 0; k < nz; k++) {
      let sum = 0, cnt = 0;
      for (let n = k * layer; n < (k + 1) * layer; n++) if (pz[n] === pz[n]) { sum += pz[n]; cnt++; }
      for (let n = k * layer; n < (k + 1) * layer; n++) if (pz[n] !== pz[n]) pz[n] = cnt ? sum / cnt : 0;
    }
  } else {
    // Box height ~0.6× the width for small areas, capped so large domains stay flat.
    levelSpacing = (0.6 * Math.min(ext, 500)) / Math.max(nz - 1, 1);
    for (let k = 0; k < nz; k++) pz.fill((nz - 1 - k) * levelSpacing, k * nx * ny, (k + 1) * nx * ny);
  }
  let zmin = Infinity, zmax = -Infinity;
  for (const z of pz) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
  state.geo = { px, py, pz, lon0, lat0, kx, ky, ext, zmin, zmax, levelSpacing };
}

function dataRange() {
  const f = state.grid.data[state.grid.param];
  let lo = Infinity, hi = -Infinity;
  for (const v of f) if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

function rebuildAll() {
  computeGeo();
  const g = state.grid;
  const [lo, hi] = dataRange();
  g.min = lo;
  g.max = hi;
  if ($('autoRange').checked) {
    $('rangeMin').value = Math.floor(lo);
    $('rangeMax').value = Math.ceil(hi);
  }
  for (const iso of state.isos) updateIsoRange(iso);
  setupSliceSliders();
  updateColormap();
  buildBox();
  buildBorders();
  buildGround();
  buildSlices();
  for (const iso of state.isos) buildIso(iso);
  buildVolume();
  applyRenderMode();
  applyVScale();
  updateHud();
}

// ---------------------------------------------------------------- volume

function disposeVolume() {
  if (!state.volume) return;
  volumeGroup.remove(state.volume.mesh);
  state.volume.mesh.geometry.dispose();
  state.volume.tex.dispose();
  state.volume = null;
}

function buildVolume() {
  disposeVolume();
  const g = state.grid;
  if (!g || g.nz < 2 || $('renderMode').value === 'iso') return;
  const { px, py, pz, zmin, zmax } = state.geo;
  const vol = resampleVolume(g.data[g.param], g.nx, g.ny, g.nz, pz, zmin, zmax, g.vmode !== 'pressure' || !g.data[PRESSURE_PARAM]);
  const tex = createVolumeTexture(vol, g.nx, g.ny);
  volumeUniforms.vol.value = tex;
  volumeUniforms.texSize.value.set(g.nx, g.ny, vol.depth);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), volumeMaterial);
  mesh.scale.set(px.at(-1) - px[0], py.at(-1) - py[0], zmax - zmin);
  mesh.position.set((px[0] + px.at(-1)) / 2, (py[0] + py.at(-1)) / 2, (zmin + zmax) / 2);
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  volumeGroup.add(mesh);
  state.volume = { mesh, tex };
}

function applyRenderMode() {
  const mode = $('renderMode').value;
  isoGroup.visible = mode !== 'volume';
  volumeGroup.visible = mode !== 'iso';
  $('volumeOpts').hidden = mode === 'iso';
  if (volumeGroup.visible && !state.volume) buildVolume();
}

function updateVolumeSettings() {
  volumeUniforms.style.value = Number($('volStyle').value);
  volumeUniforms.width.value = Number($('volWidth').value);
  const density = 10 ** Number($('volDensity').value); // log slider, 0.05 … 20
  volumeUniforms.density.value = density;
  $('volDensity').nextElementSibling.textContent = density.toFixed(density < 1 ? 2 : 1);
  volumeUniforms.steps.value = Number($('volSteps').value);
  updateVolumeColors();
}

// Colour-map range of the volume: the colour-bar range, or stretched over the values it fills.
function volumeColorRange() {
  const g = state.grid;
  const vis = state.isos.filter((i) => i.visible).slice(0, MAX_ISO_LINES);
  const lo = Number($('rangeMin').value), hi = Number($('rangeMax').value);
  if ($('volColor').value !== 'fit' || !g || !vis.length) return [lo, hi];
  const style = Number($('volStyle').value), w = Number($('volWidth').value), t = vis[0].value;
  if (style === 1) return [g.min, t];
  if (style === 0) return [t, g.max];
  const vals = vis.map((i) => i.value);
  return [Math.min(...vals) - 1.5 * w, Math.max(...vals) + 1.5 * w];
}

function updateVolumeColors() {
  const mode = $('volColor').value;
  const [lo, hi] = volumeColorRange();
  volumeUniforms.useCmap.value = mode === 'iso' ? 0 : 1;
  volumeUniforms.cmin.value = lo;
  volumeUniforms.cmax.value = hi;
  $('volCbarWrap').hidden = mode === 'iso';
  drawColorbar($('volColorbar'), $('colormap').value);
  $('volCbarMin').textContent = fmt(lo, 1);
  $('volCbarMax').textContent = fmt(hi, 1);
  $('volCbarUnit').textContent = state.grid?.unit || '';
}

function buildBox() {
  disposeChildren(boxGroup);
  const { px, py, zmin, zmax } = state.geo;
  const box = new THREE.Box3(new THREE.Vector3(px[0], py[0], zmin), new THREE.Vector3(px.at(-1), py.at(-1), zmax));
  const helper = new THREE.Box3Helper(box, 0x4a5868);
  boxGroup.add(helper);
  boxGroup.visible = $('boxOn').checked;
}

function clipSegment(ax, ay, bx, by, r) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy], q = [ax - r[0], r[2] - ax, ay - r[1], r[3] - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
      else { if (t < t0) return null; if (t < t1) t1 = t; }
    }
  }
  return [ax + t0 * dx, ay + t0 * dy, ax + t1 * dx, ay + t1 * dy];
}

function buildBorders() {
  disposeChildren(mapGroup);
  if (!state.grid) return;
  const { lons, lats } = state.grid;
  const { lon0, lat0, kx, ky, zmin, px, py, ext } = state.geo;
  const z = zmin - ext * 0.002;
  if (state.borders) {
    const rect = [lons[0], lats[0], lons.at(-1), lats.at(-1)];
    const pts = [];
    for (const line of state.borders) {
      for (let n = 1; n < line.length; n++) {
        const s = clipSegment(line[n - 1][0], line[n - 1][1], line[n][0], line[n][1], rect);
        if (s) pts.push((s[0] - lon0) * kx, (s[1] - lat0) * ky, z, (s[2] - lon0) * kx, (s[3] - lat0) * ky, z);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    mapGroup.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xc8d3de })));
  }
  mapGroup.visible = $('bordersOn').checked;
}

// ---------------------------------------------------------------- WMS base map

function getMapTexture(url) {
  if (state.mapTex?.url === url) return state.mapTex.promise;
  state.mapTex?.tex?.dispose();
  const entry = { url, tex: null };
  entry.promise = new THREE.TextureLoader().loadAsync(url)
    .then((tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      entry.tex = tex;
      return tex;
    })
    .catch((e) => {
      console.warn('Base map could not be loaded', e);
      if (state.mapTex === entry) state.mapTex = null;
      return null;
    });
  state.mapTex = entry;
  return entry.promise;
}

// Ground plane under the cube, textured with a WMS GetMap image in CRS:84 (plain lon/lat, which
// maps linearly onto the scene's x/y).
function buildGround() {
  disposeChildren(groundGroup);
  if (!state.grid) return;
  const { lons, lats } = state.grid;
  const { px, py, zmin, ext } = state.geo;
  const w = px.at(-1) - px[0], h = py.at(-1) - py[0];
  const mat = new THREE.MeshBasicMaterial({
    color: 0x18212b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  ground.position.set((px[0] + px.at(-1)) / 2, (py[0] + py.at(-1)) / 2, zmin - ext * 0.003);
  groundGroup.add(ground);

  const layer = $('baseLayer').value;
  if (!layer) return;
  const iw = 1536, ih = Math.min(2048, Math.round((iw * h) / w));
  const url = `${WMS_URL}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&CRS=CRS:84&BBOX=${lons[0]},${lats[0]},${lons.at(-1)},${lats.at(-1)}` +
    `&WIDTH=${iw}&HEIGHT=${ih}&FORMAT=image/png&TRANSPARENT=FALSE`;
  getMapTexture(url).then((tex) => {
    if (!tex || ground.parent !== groundGroup) return;
    mat.map = tex;
    mat.color.setScalar(Number($('mapBrightness').value));
    mat.needsUpdate = true;
  });
}

async function loadBaseLayers() {
  const sel = $('baseLayer');
  let layers = [];
  try {
    const r = await fetch(`${WMS_URL}SERVICE=WMS&REQUEST=GetCapabilities`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const child = (el, tag) => [...el.children].find((c) => c.localName === tag)?.textContent;
    layers = [...doc.getElementsByTagNameNS('*', 'Layer')]
      .map((l) => ({ name: child(l, 'Name'), title: child(l, 'Title') }))
      .filter((l) => l.name);
  } catch (e) {
    console.warn('Could not read baselayers capabilities', e);
    return;
  }
  const current = sel.value;
  sel.innerHTML = '';
  sel.append(option('', 'None'));
  for (const l of layers) sel.append(option(l.name, l.title && l.title !== l.name ? l.title : l.name));
  sel.value = layers.some((l) => l.name === current) ? current : '';
}

async function loadBorders() {
  try {
    const topo = await fetchJSON(BORDERS_URL, { retries: 1 });
    state.borders = topojson.mesh(topo, topo.objects.countries).coordinates;
    if (state.grid) buildBorders();
  } catch (e) {
    console.warn('Could not load borders', e);
  }
}

// ---------------------------------------------------------------- slices

function setupSliceSliders() {
  const { nx, ny, nz } = state.grid;
  const set = (id, max, def) => {
    const el = $(id);
    const prevMax = Number(el.max), prev = Number(el.value);
    el.max = max;
    el.value = prevMax === max && prev <= max ? prev : def;
  };
  set('sliceZ', nz - 1, 0); // 0 = lowest level, so the slider moves the slice upwards
  set('sliceX', nx - 1, Math.floor(nx / 2));
  set('sliceY', ny - 1, Math.floor(ny / 2));
}

// Builds a slice surface; mapper(u, v) returns grid indices [i, j, k].
function sliceGeometry(nu, nv, mapper) {
  const { nx, ny, data, param } = state.grid;
  const { px, py, pz } = state.geo;
  const field = data[param];
  const pos = new Float32Array(nu * nv * 3), val = new Float32Array(nu * nv), ijk = new Float32Array(nu * nv * 3);
  for (let v = 0; v < nv; v++) {
    for (let u = 0; u < nu; u++) {
      const [i, j, k] = mapper(u, v);
      const n = v * nu + u, p = (k * ny + j) * nx + i;
      pos.set([px[i], py[j], pz[p]], n * 3);
      ijk.set([i, j, k], n * 3);
      val[n] = field[p] === field[p] ? field[p] : -1e30;
    }
  }
  const idx = [];
  for (let v = 0; v < nv - 1; v++) {
    for (let u = 0; u < nu - 1; u++) {
      const a = v * nu + u, b = a + 1, c = a + nu, d = c + 1;
      idx.push(a, b, d, a, d, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('value', new THREE.BufferAttribute(val, 1));
  geom.setAttribute('ijk', new THREE.BufferAttribute(ijk, 3));
  geom.setIndex(idx);
  return geom;
}

function buildSlices() {
  disposeChildren(sliceGroup);
  const g = state.grid;
  if (!g) return;
  const { nx, ny, nz, levels, lons, lats } = g;
  const kz = nz - 1 - Number($('sliceZ').value), ix = Number($('sliceX').value), jy = Number($('sliceY').value);
  $('sliceZOut').textContent = `lvl ${levels[kz]}`;
  $('sliceXOut').textContent = `${fmt(lons[ix], 2)}°E`;
  $('sliceYOut').textContent = `${fmt(lats[jy], 2)}°N`;
  const add = (geom) => sliceGroup.add(new THREE.Mesh(geom, sliceMaterial));
  if ($('sliceZOn').checked) add(sliceGeometry(nx, ny, (u, v) => [u, v, kz]));
  if (nz > 1 && $('sliceXOn').checked) add(sliceGeometry(ny, nz, (u, v) => [ix, u, v]));
  if (nz > 1 && $('sliceYOn').checked) add(sliceGeometry(nx, nz, (u, v) => [u, jy, v]));
}

// ---------------------------------------------------------------- isosurfaces

const DEFAULT_ISO_COLORS = ['#ff8c1a', '#3fa7ff', '#5ad16b', '#e05cff'];

function addIso(value = 10, color) {
  const iso = { value, color: color || DEFAULT_ISO_COLORS[state.isos.length % DEFAULT_ISO_COLORS.length], visible: true, mesh: null };
  const row = document.createElement('div');
  row.className = 'iso-row';
  row.innerHTML = `
    <input type="checkbox" checked title="Visible">
    <input type="range" step="0.1" min="-80" max="40">
    <input type="number" step="0.1">
    <input type="color" title="Colour">
    <button class="icon" title="Remove">✕</button>
    <div class="tri"></div>`;
  const [chk, range, num, col, del] = row.querySelectorAll('input, button');
  iso.el = { row, range, num, info: row.querySelector('.tri') };
  range.value = num.value = value;
  col.value = iso.color;

  let queued = false;
  const setValue = (v) => {
    if (!Number.isFinite(v)) return;
    iso.value = v;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; buildIso(iso); updateIsoLines(); });
  };
  range.addEventListener('input', () => { num.value = range.value; setValue(Number(range.value)); });
  num.addEventListener('input', () => { range.value = num.value; setValue(Number(num.value)); });
  chk.addEventListener('change', () => { iso.visible = chk.checked; buildIso(iso); updateIsoLines(); });
  col.addEventListener('input', () => {
    iso.color = col.value;
    iso.mesh?.material.color.set(iso.color);
    updateIsoLines();
  });
  del.addEventListener('click', () => {
    disposeIso(iso);
    row.remove();
    state.isos.splice(state.isos.indexOf(iso), 1);
    updateIsoLines();
  });

  $('isoList').append(row);
  state.isos.push(iso);
  if (state.grid) {
    updateIsoRange(iso);
    buildIso(iso);
  }
  updateIsoLines();
  return iso;
}

function updateIsoRange(iso) {
  const { min, max } = state.grid;
  const step = (max - min) > 50 ? 0.5 : 0.1;
  iso.el.range.min = Math.floor(min);
  iso.el.range.max = Math.ceil(max);
  iso.el.range.step = step;
  iso.el.range.value = iso.value;
}

function disposeIso(iso) {
  if (!iso.mesh) return;
  isoGroup.remove(iso.mesh);
  iso.mesh.geometry.dispose();
  iso.mesh.material.dispose();
  iso.mesh = null;
}

function buildIso(iso) {
  disposeIso(iso);
  const g = state.grid;
  if (!g || !iso.visible || g.nz < 2) {
    iso.el.info.textContent = g && g.nz < 2 ? 'need ≥ 2 levels' : '';
    return;
  }
  const { px, py, pz } = state.geo;
  const t0 = performance.now();
  const r = marchingCubes(g.data[g.param], g.nx, g.ny, g.nz, iso.value, px, py, pz);
  const ms = performance.now() - t0;
  const tris = r.indices.length / 3;
  iso.el.info.textContent = tris ? `${tris.toLocaleString()} triangles · ${ms.toFixed(0)} ms` : 'value not crossed in this cube';
  if (!tris) return;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
  geom.setAttribute('ijk', new THREE.BufferAttribute(r.ijk, 3));
  geom.setIndex(new THREE.BufferAttribute(r.indices, 1));
  geom.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
  const opacity = Number($('isoOpacity').value);
  const mat = new THREE.MeshStandardMaterial({
    color: iso.color, roughness: 0.55, metalness: 0.05, side: THREE.DoubleSide,
    transparent: opacity < 1, opacity,
  });
  iso.mesh = new THREE.Mesh(geom, mat);
  iso.mesh.userData.iso = iso;
  // Depth pre-pass: when semi-transparent, only the front-most layer of the surface is blended,
  // instead of all layers in arbitrary triangle order (which shows up as streaks).
  const prepass = new THREE.Mesh(geom, isoDepthMaterial);
  prepass.renderOrder = 1; // after the opaque ground/borders, before transparent objects
  prepass.visible = opacity < 1;
  iso.mesh.add(prepass);
  iso.prepass = prepass;
  isoGroup.add(iso.mesh);
}

function updateIsoLines() {
  const vis = state.isos.filter((i) => i.visible).slice(0, MAX_ISO_LINES);
  const on = $('isoLinesOn').checked;
  sliceUniforms.isoCount.value = on ? vis.length : 0;
  volumeUniforms.isoCount.value = vis.length;
  vis.forEach((iso, n) => {
    sliceUniforms.isoValues.value[n] = iso.value;
    sliceUniforms.isoColors.value[n].fromArray(hexToRgb(iso.color));
  });
  drawCbar();
  updateHud();
}

// ---------------------------------------------------------------- appearance

function updateColormap() {
  const name = $('colormap').value;
  sliceUniforms.cmap.value.dispose();
  sliceUniforms.cmap.value = makeColormapTexture(name);
  sliceUniforms.vmin.value = Number($('rangeMin').value);
  sliceUniforms.vmax.value = Number($('rangeMax').value);
  sliceUniforms.interval.value = Number($('contourInterval').value);
  sliceUniforms.showContours.value = $('contoursOn').checked ? 1 : 0;
  sliceUniforms.opacity.value = Number($('sliceOpacity').value);
  sliceMaterial.depthWrite = sliceUniforms.opacity.value >= 0.99;
  drawCbar();
}

function drawCbar() {
  const lo = Number($('rangeMin').value), hi = Number($('rangeMax').value);
  const marks = state.isos.filter((i) => i.visible).map((i) => ({ t: (i.value - lo) / (hi - lo), color: i.color }));
  drawColorbar($('colorbar'), $('colormap').value, marks);
  $('cbarMin').textContent = fmt(lo, 1);
  $('cbarMax').textContent = fmt(hi, 1);
  $('cbarUnit').textContent = state.grid?.unit || '';
  updateVolumeColors();
}

function makeLabel(text, height) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const fs = 44;
  ctx.font = `${fs}px system-ui, sans-serif`;
  c.width = Math.ceil(ctx.measureText(text).width) + 12;
  c.height = fs + 12;
  ctx.font = `${fs}px system-ui, sans-serif`;
  ctx.fillStyle = '#c8d3de';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 6, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, fog: false }));
  sprite.scale.set((height * c.width) / c.height, height, 1);
  return sprite;
}

function niceStep(range, maxTicks) {
  for (const s of [0.25, 0.5, 1, 2, 5, 10, 20, 50]) if (range / s <= maxTicks) return s;
  return 100;
}

function buildLabels() {
  disposeChildren(labelGroup);
  if (!state.grid) return;
  labelGroup.visible = $('labelsOn').checked;
  const { lons, lats, levels, vmode } = state.grid;
  const { px, py, lon0, lat0, kx, ky, ext, zmin, zmax, levelSpacing } = state.geo;
  const s = vscale(), h = ext * 0.028, z0 = zmin * s, pad = ext * 0.04;
  const add = (text, x, y, z) => {
    const l = makeLabel(text, h);
    l.position.set(x, y, z);
    labelGroup.add(l);
  };
  const lonStep = niceStep(lons.at(-1) - lons[0], 6);
  for (let l = Math.ceil(lons[0] / lonStep) * lonStep; l <= lons.at(-1); l += lonStep) add(`${+l.toFixed(2)}°E`, (l - lon0) * kx, py[0] - pad, z0);
  const latStep = niceStep(lats.at(-1) - lats[0], 6);
  for (let l = Math.ceil(lats[0] / latStep) * latStep; l <= lats.at(-1); l += latStep) add(`${+l.toFixed(2)}°N`, px[0] - pad * 1.6, (l - lat0) * ky, z0);

  const x = px[0] - pad, y = py.at(-1) + pad; // vertical axis on the north-west corner
  if (vmode === 'pressure') {
    const kmMax = zmax / KM_SCALE, step = niceStep(kmMax, Math.max(1, Math.min(8, Math.floor((zmax * s) / (1.4 * h)))));
    for (let km = 0; km <= kmMax; km += step) add(`${km} km`, x, y, km * KM_SCALE * s);
  } else {
    // Pick a level step that leaves at least ~1.4 label heights between labels.
    const nz = levels.length, room = (nz - 1) * levelSpacing * s;
    const step = [1, 2, 5, 10, 20, 40, 80].find((st) => room / Math.max(1, (nz - 1) / st) >= 1.4 * h) ?? 100;
    for (let k = 0; k < nz; k++) {
      const end = k === 0 || k === nz - 1, nearEnd = Math.min(k, nz - 1 - k) < step / 2;
      if (end || (levels[k] % step === 0 && !nearEnd)) add(`L${levels[k]}`, x, y, (nz - 1 - k) * levelSpacing * s);
    }
  }
}

function applyVScale() {
  const s = vscale();
  dataGroup.scale.z = s;
  $('vscale').nextElementSibling.textContent = `×${s.toFixed(s < 1 ? 2 : 1)}`;
  buildLabels();
}

function fitCamera() {
  if (!state.geo) return;
  const { ext, zmin, zmax } = state.geo;
  const s = vscale(), zmid = ((zmin + zmax) / 2) * s;
  const d = Math.max(ext, (zmax - zmin) * s) * 1.5;
  controls.target.set(0, 0, zmid);
  camera.position.set(-d * 0.35, -d * 0.95, zmid + d * 0.55);
  camera.near = d / 500;
  camera.far = d * 20;
  camera.updateProjectionMatrix();
  controls.update();
}

function updateHud() {
  const g = state.grid;
  if (!g) { $('hud').innerHTML = ''; return; }
  const isoTxt = state.isos.filter((i) => i.visible).map((i) => `${fmt(i.value)} ${g.unit}`).join(', ');
  $('hud').innerHTML =
    `<b>${g.param}</b> · ${g.datetime || ''}<br>` +
    `run ${g.instance || '–'} · levels ${g.levels[0]}–${g.levels.at(-1)} · ${g.nx}×${g.ny}×${g.nz}<br>` +
    `range ${fmt(g.min)} … ${fmt(g.max)} ${g.unit}` + (isoTxt ? `<br>isosurface ${isoTxt}` : '');
}

// ---------------------------------------------------------------- picking

const raycaster = new THREE.Raycaster();
const tri = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
const triIjk = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

function pick() {
  const tip = $('tooltip');
  const g = state.grid;
  if (!g) { tip.hidden = true; return; }
  raycaster.setFromCamera(pointer, camera);
  const targets = [...sliceGroup.children, ...isoGroup.children];
  const hit = raycaster.intersectObjects(targets, false)[0];
  if (!hit) { tip.hidden = true; return; }
  const geom = hit.object.geometry, pos = geom.getAttribute('position'), ijkAttr = geom.getAttribute('ijk');
  const { a, b, c } = hit.face;
  [a, b, c].forEach((v, n) => { tri[n].fromBufferAttribute(pos, v); triIjk[n].fromBufferAttribute(ijkAttr, v); });
  const local = hit.object.worldToLocal(hit.point.clone());
  const ijk = THREE.Triangle.getInterpolation(local, tri[0], tri[1], tri[2], triIjk[0], triIjk[1], triIjk[2], new THREE.Vector3());
  const iso = hit.object.userData.iso;
  const value = iso ? iso.value : sampleField(g.data[g.param], ijk.x, ijk.y, ijk.z);
  const lines = [
    `<b>${fmt(value, 2)} ${g.unit}</b>${iso ? ' (isosurface)' : ''}`,
    `${fmt(lerpArr(g.lons, ijk.x), 3)}°E ${fmt(lerpArr(g.lats, ijk.y), 3)}°N`,
    `model level ${fmt(lerpArr(g.levels, ijk.z), 1)}`,
  ];
  const p = g.data[PRESSURE_PARAM];
  if (p) {
    const hpa = sampleField(p, ijk.x, ijk.y, ijk.z);
    lines.push(`${fmt(hpa, 1)} hPa ≈ ${fmt(isaAltitudeKm(hpa), 2)} km`);
  }
  tip.innerHTML = lines.join('<br>');
  tip.hidden = false;
}

canvas.addEventListener('pointermove', (e) => {
  const r = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  const tip = $('tooltip');
  tip.style.left = `${e.clientX - r.left + 14}px`;
  tip.style.top = `${e.clientY - r.top + 14}px`;
  pickPending = true;
});
canvas.addEventListener('pointerleave', () => ($('tooltip').hidden = true));

// ---------------------------------------------------------------- UI wiring

for (const name of COLORMAP_NAMES) $('colormap').append(option(name, name));

for (const id of ['isoOpacity', 'sliceOpacity', 'volWidth', 'volSteps', 'mapBrightness', 'hazeAmount']) {
  const el = $(id), out = el.nextElementSibling;
  const show = () => (out.textContent = Number(el.step) >= 1 ? el.value : Number(el.value).toFixed(2));
  el.addEventListener('input', show);
  show();
}

$('applyUrl').addEventListener('click', applyUrl);
const setBBox = (b) => ['bboxW', 'bboxS', 'bboxE', 'bboxN'].forEach((id, n) => ($(id).value = b[n]));
$('defaultDomain').addEventListener('click', () => {
  setBBox(parseCubeUrl(DEFAULT_URL).bbox);
  $('stride').value = 'auto'; // a preset may have left a coarse step that would ruin the small area
  loadData();
});
// Model domain extent from the instance (or collection) metadata, rounded outwards.
function fullDomainBBox() {
  const inst = state.instances.find((i) => i.id === $('instance').value);
  const bbox = (inst || state.collection)?.extent?.spatial?.bbox?.[0];
  if (!bbox) return null;
  const round = (v, up) => (up ? Math.ceil(v * 100) : Math.floor(v * 100)) / 100;
  return bbox.map((v, n) => round(v, n >= 2));
}

$('fullDomain').addEventListener('click', () => {
  const bbox = fullDomainBBox();
  if (!bbox) {
    setStatus('No spatial extent in the collection metadata', true);
    return;
  }
  setBBox(bbox);
  loadData();
});

function applyPreset(p) {
  if (!state.collection) {
    setStatus('Collection metadata not loaded yet', true);
    return;
  }
  const bbox = p.bbox === 'full' ? fullDomainBBox() : p.bbox;
  if (bbox) setBBox(bbox);
  if (p.parameter) {
    if (!state.collection.parameter_names?.[p.parameter]) {
      setStatus(`Parameter ${p.parameter} not in this collection`, true);
      return;
    }
    $('parameter').value = p.parameter;
  }
  if (p.stride != null) $('stride').value = String(p.stride);
  if (p.levels === 'all') {
    $('levelFrom').value = $('levelFrom').min || 1;
    $('levelTo').value = $('levelTo').max || 90;
  } else if (p.levels) {
    [$('levelFrom').value, $('levelTo').value] = p.levels;
  }
  if (p.renderMode) {
    $('renderMode').value = p.renderMode;
    applyRenderMode();
  }
  if (p.volStyle != null) $('volStyle').value = p.volStyle;
  if (p.threshold != null) {
    const iso = state.isos[0] || addIso(p.threshold);
    iso.value = p.threshold;
    iso.el.range.value = iso.el.num.value = p.threshold;
    if (!iso.visible) iso.el.row.querySelector('input[type=checkbox]').click();
  }
  if (p.vscale) $('vscale').value = Math.log10(p.vscale);
  updateVolumeSettings();
  updateIsoLines();
  applyVScale();
  loadData();
}

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.innerHTML = `${p.name}<small>${p.description}</small>`;
  b.addEventListener('click', () => applyPreset(p));
  $('presetList').append(b);
}
$('load').addEventListener('click', loadData);
$('cancel').addEventListener('click', () => state.abort?.abort());
$('collectionUrl').addEventListener('change', () =>
  loadCollection($('collectionUrl').value, { parameter: $('parameter').value, datetime: $('datetime').value })
    .then(() => setStatus('Collection loaded'))
    .catch((e) => setStatus(e.message, true)));
$('instance').addEventListener('change', () => updateDatetimes());
$('vmode').addEventListener('change', () => {
  if (state.grid && (state.grid.data[PRESSURE_PARAM] || $('vmode').value === 'level')) {
    state.grid.vmode = $('vmode').value;
    rebuildAll();
    fitCamera();
  } else if (state.grid) {
    setStatus('Pressure altitude needs air_pressure_ml — press Load');
  }
});

$('isoOpacity').addEventListener('input', () => {
  const o = Number($('isoOpacity').value);
  for (const iso of state.isos) {
    if (!iso.mesh) continue;
    Object.assign(iso.mesh.material, { opacity: o, transparent: o < 1 });
    iso.mesh.material.needsUpdate = true;
    iso.prepass.visible = o < 1;
  }
});
$('renderMode').addEventListener('change', applyRenderMode);
for (const id of ['volStyle', 'volColor', 'volWidth', 'volDensity', 'volSteps']) {
  $(id).addEventListener('input', updateVolumeSettings);
}
$('cancel2').addEventListener('click', () => state.abort?.abort());
$('addIso').addEventListener('click', () => {
  const g = state.grid;
  addIso(g ? +((g.min + g.max) / 2).toFixed(1) : 0);
});

for (const id of ['sliceZOn', 'sliceXOn', 'sliceYOn', 'sliceZ', 'sliceX', 'sliceY']) {
  $(id).addEventListener('input', buildSlices);
}
for (const id of ['sliceOpacity', 'contoursOn', 'contourInterval', 'colormap', 'rangeMin', 'rangeMax']) {
  $(id).addEventListener('input', updateColormap);
}
$('isoLinesOn').addEventListener('input', updateIsoLines);
$('autoRange').addEventListener('change', () => {
  const auto = $('autoRange').checked;
  $('rangeMin').disabled = $('rangeMax').disabled = auto;
  if (auto && state.grid) {
    $('rangeMin').value = Math.floor(state.grid.min);
    $('rangeMax').value = Math.ceil(state.grid.max);
    updateColormap();
  }
});
$('vscale').addEventListener('input', applyVScale);
$('bordersOn').addEventListener('change', () => (mapGroup.visible = $('bordersOn').checked));
$('baseLayer').addEventListener('change', buildGround);
$('mapBrightness').addEventListener('input', () => {
  const mat = groundGroup.children[0]?.material;
  if (mat?.map) mat.color.setScalar(Number($('mapBrightness').value));
});
$('boxOn').addEventListener('change', () => (boxGroup.visible = $('boxOn').checked));
$('labelsOn').addEventListener('change', () => (labelGroup.visible = $('labelsOn').checked));
$('resetView').addEventListener('click', fitCamera);

// ---------------------------------------------------------------- start

$('url').value = DEFAULT_URL;
addIso(4.5, '#ff8c1a');
updateVolumeSettings();
applyRenderMode();
applyVScale();
updateColormap();
loadBorders();
loadBaseLayers();
applyUrl();
