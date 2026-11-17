import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as topojson from 'topojson-client';
import { VECTOR_LAYER, drawVectorMap, landPolygons, gridProjection } from './vectormap.js';
import { fetchJSON, parseTemporalValues, parseCubeUrl, toIso, loadCube, MAX_POINTS_PER_LEVEL } from './edr.js';
import { frameStoreUsage, clearFrames, evictFrames } from './framestore.js';
import { marchingCubes } from './isosurface.js';
import { COLORMAP_NAMES, makeColormapTexture, drawColorbar, hexToRgb } from './colormaps.js';
import { resampleVolume, createVolumeMaterial, createVolumeTexture, updateVolumeCamera } from './volume.js';
import { nativeCubeCrs, bboxToRot, bboxToGeo } from './rotpole.js';
import { Streamlines } from './streamlines.js';
import { sunPosition, moonPosition, skyEcef, enuFrame, dot, ecefOf } from './sun.js';
import { STARS, STAR_NAMES } from './stars.js';
import { makeGlobe, EARTH_RADIUS } from './globe.js';

// No instance or time: runs expire on the server, so startup takes the latest run and its first time
const DEFAULT_COLLECTION = 'https://geoservices.knmi.nl/edr/collections/uwcw-ha-det-dini-5p5km.ml';
const DEFAULT_URL = `${DEFAULT_COLLECTION}/cube?bbox=3,50.7,7.3,53.6&z=1/90&parameter-name=wind_speed_ml`;
const WMS_URL = 'https://geoservices.knmi.nl/wms?DATASET=baselayers&';
const BORDERS_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-10m.json';

// Derived parameter: wind speed with the wind direction, for streamlines. Offered when a collection has both
// wind_speed… and wind_from_direction… or wind_direction… (any separator, same suffix); the direction is where
// the wind comes from, as usual in meteorology.
const WIND_OPTION = '__wind__';
function windPairOf(collection) {
  const ids = Object.keys(collection?.parameter_names || {});
  for (const speed of ids) {
    const m = /^wind([-_])speed(.*)$/i.exec(speed);
    if (!m) continue;
    const dir = ids.find((id) => new RegExp(`^wind[-_](from[-_])?direction${m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(id));
    if (dir) return { speed, dir };
  }
  return null;
}

// Vertical coordinate of a collection: from its VERTCRS when the server gives one, otherwise (adaguc gives
// 'customvrs') from the names: …pl → pressure levels (hPa), …hagl/…height → height above ground (m), otherwise model
// levels (1 = top). Level values are ordered top first, as the scene expects (k = 0 is the highest level).
const VERTICAL_KINDS = {
  level: { label: 'model levels', unit: '', text: (v) => `L${v}` },
  pressure: { label: 'pressure levels', unit: 'hPa', text: (v) => `${v} hPa` },
  height: { label: 'heights', unit: 'm', text: (v) => `${v} m` },
};
function verticalKindOf(collection) {
  // A real vertical CRS (e.g. VERTCRS["Atmospheric pressure",…,UNIT["hPa",100]]) says it directly
  const vrs = String(collection?.extent?.vertical?.vrs || '').toLowerCase();
  if (/vertcrs/.test(vrs)) {
    if (/pressure|hpa/.test(vrs)) return 'pressure';
    if (/height|altitude|metre|meter/.test(vrs)) return 'height';
  }
  const names = [collection?.id || '', ...Object.keys(collection?.parameter_names || {})].join(' ').toLowerCase();
  if (/(^|[._\s-])pl(\b|$)/.test(names)) return 'pressure';
  if (/(^|[._\s-])(a?hagl|height)(\b|$)/.test(names)) return 'height';
  return 'level';
}
function verticalOf(collection) {
  const kind = verticalKindOf(collection);
  const values = [...new Set((collection?.extent?.vertical?.values || []).map(Number).filter(Number.isFinite))];
  values.sort((a, b) => (kind === 'height' ? b - a : a - b)); // top first: low pressure / high above ground
  return { kind, values, ...VERTICAL_KINDS[kind] };
}

// Pressure on model levels, named air_pressure_ml or air-pressure-ml depending on the server.
const pressureParamOf = (collection) =>
  Object.keys(collection?.parameter_names || {}).find((id) => /^air[-_]pressure[-_]ml$/.test(id)) || 'air_pressure_ml';

// One-click views. collectionUrl: switch to this collection first (latest instance);
// crs: 'native' = the model's own grid (when the collection offers it), otherwise EPSG:4326;
// bbox: 'full' = model domain extent, or [W, S, E, N]; levels: 'all' or [from, to];
// stride: horizontal step ('auto' or 1–8); levelStep: vertical step (every n-th level, 1–8); gridCells: draw the grid cells;
// sky / earth: sky with horizon and stars, earth surface around the data;
// threshold sets the first isosurface value (also the volume's fill threshold); density: volume density (0.05–20);
// resolution: [x, y] points the server resamples to (EDR resolution-x/-y), for servers with a size limit;
// levelsPerRequest: levels per cube request.
const PRESETS = [
  {
    name: 'Jet stream – DINI (uwcw-ha-det-dini-5p5km, geoservices)',
    description: 'KNMI UWCW HARMONIE DINI 5.5 km from geoservices.knmi.nl, on its native rotated pole grid: wind speed on the full domain, every 4th model level from level 4, 4×4 averaged, volume filled above 50 kt, vertical scale ×10',
    collectionUrl: DEFAULT_COLLECTION,
    crs: 'native', // the model's rotated pole grid, without resampling to lon/lat
    bbox: 'full',
    stride: '4', // horizontal step: 'auto' or 1–8
    levelStep: 4,
    levelsPerRequest: 8,
    parameter: 'wind_speed_ml',
    levels: [4, 90], // from level 4: the levels above are near the model top
    renderMode: 'volume',
    volStyle: '0', // 0 = fill above, 1 = fill below, 2 = band
    threshold: 50,
    density: 2.2,
    vscale: 10,
    sky: true,
    earth: true,
    globe: false,
    sun: false,
    starNames: false,
    tour: false,
    baseLayer: 'knmi_animated_gif_background_europe_elevation_1km_combined',
  },
  {
    name: 'Jet stream core on the globe – DINI (geoservices)',
    description: 'As the DINI preset, on the globe at night: only the core of the jet stream (volume filled above 93.5 kt, coloured over the filled range), with the sun, moon and stars at the shown time and the star names, vertical scale ×4.9',
    collectionUrl: DEFAULT_COLLECTION,
    crs: 'native',
    bbox: 'full',
    stride: '4',
    levelStep: 4,
    levelsPerRequest: 8,
    parameter: 'wind_speed_ml',
    levels: [4, 90],
    renderMode: 'volume',
    volStyle: '0',
    threshold: 93.5,
    density: 0.83,
    vscale: 4.9,
    sky: true,
    earth: true,
    globe: true,
    sun: true,
    starNames: true,
    tween: -1, // continuous: on the GPU while only the volume is shown
    baseLayer: 'knmi_animated_gif_background_europe_elevation_1km_combined',
    view: { azimuth: 150, elevation: 30, distance: 0.95 }, // from the south-east, above the Mediterranean
  },
  {
    name: 'Jet streams – global (ECMWF IFS, meteocore)',
    description: 'ECMWF IFS 0.25° from FMI meteocore: wind speed on all 14 pressure levels (1000–10 hPa) at their height, the whole Earth resampled by the server to 720×360 points, on the globe, volume filled above 33 m/s (≈ 64 kt), with the sun, moon and stars, flying around',
    collectionUrl: 'https://meteocore.app.meteo.fi/edr/collections/ecmwf-ifs-pressure',
    crs: '',
    bbox: 'full',
    stride: '1', // the server already resamples
    levelStep: 1,
    resolution: [720, 360], // 0.5°
    levelsPerRequest: 1, // meteocore counts 2 values per cell: 720 × 360 × 2 = 518 k, within its limit of a million
    parameter: 'ws',
    levels: 'all',
    renderMode: 'volume',
    volStyle: '0',
    threshold: 33,
    density: 0.8,
    vscale: 3.5,
    sky: true,
    earth: true,
    globe: true,
    sun: true,
    starNames: true,
    tween: -1,
    tour: true,
    baseLayer: VECTOR_LAYER, // land and sea from Natural Earth vectors: the whole world, without a WMS
  },
  {
    name: 'Jet stream – Nordic (MEPS, meteocore)',
    description: 'MEPS forecast from FMI meteocore: wind speed on 13 pressure levels (1000–50 hPa) at their height, resampled by the server to 300×300 points, volume filled above 25 m/s (≈ 50 kt), vertical scale ×15',
    collectionUrl: 'https://meteocore.app.meteo.fi/edr/collections/meps-netcdf-pressure',
    crs: '',
    bbox: 'full',
    stride: '1', // the server already resamples
    levelStep: 1,
    resolution: [300, 300], // the full domain at the native 2.5 km grid is over the server's limit of 1 M values per request
    levelsPerRequest: 5, // 5 × 300 × 300 points × 2 values = 900 k, within the limit
    parameter: 'wind_speed_pl',
    levels: 'all',
    renderMode: 'volume',
    volStyle: '0',
    threshold: 25,
    density: 2.2,
    vscale: 15,
    sky: true,
    earth: true,
    globe: false,
    sun: false,
    starNames: false,
    tour: false,
    baseLayer: 'knmi_animated_gif_background_europe_elevation_1km_combined',
  },
];
const KM_SCALE = 5; // world units per km of altitude in pressure-altitude mode
const MAX_ISO_LINES = 4;

const $ = (id) => document.getElementById(id);
let renderFrames = 3; // frames still to draw, see requestRender

const state = {
  collection: null,
  instances: [],
  grid: null, // loaded cube, see edr.js loadCube
  geo: null, // world coordinates derived from grid
  isos: [],
  borders: null, // [[ [lon, lat], ... ], ...]
  abort: null,
  volume: null, // { mesh, tex }
  mapTex: {}, // slot ('ground', 'earth') → { url, promise, tex }: cached WMS base map textures
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

const hemiLight = new THREE.HemisphereLight(0xdde8ff, 0x2a3440, 1.4);
scene.add(hemiLight);

// Optional sky as a reference while flying: a dome with a gradient towards the zenith, a faint line at the
// true horizon, dark ground below it and stars above it. It moves with the camera, so it is infinitely far
// away: flying does not get you closer, but turning, pitching and banking show against it. Drawn first,
// behind everything else, and not affected by the depth haze.
const skyGroup = new THREE.Group();
skyGroup.visible = false;
let skyDomeMaterial; // set below; the sun and the globe change it
{
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(1, 64, 32),
    (skyDomeMaterial = new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: new THREE.Vector3(0, 0, -1) }, daylight: { value: 0 }, space: { value: 0 } },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 sunDir; // towards the sun, z is up
        uniform float daylight; // 0 at night (or without the sun), 1 with the sun well above the horizon
        uniform float space; // 0 near the ground, 1 far above the globe: black space
        varying vec3 vDir;
        void main() {
          vec3 dir = normalize(vDir);
          float h = dir.z; // sine of the elevation, z is up
          // Night colours, and day colours mixed in with the daylight
          vec3 zenith = mix(vec3(0.012, 0.018, 0.040), vec3(0.10, 0.24, 0.50), daylight);
          vec3 skyHorizon = mix(vec3(0.150, 0.200, 0.270), vec3(0.50, 0.63, 0.78), daylight);
          vec3 groundHorizon = mix(vec3(0.105, 0.115, 0.125), vec3(0.30, 0.33, 0.36), daylight);
          vec3 groundDeep = mix(vec3(0.035, 0.040, 0.045), vec3(0.12, 0.13, 0.14), daylight);
          vec3 c = h >= 0.0 ? mix(skyHorizon, zenith, pow(h, 0.4)) : mix(groundHorizon, groundDeep, pow(-h, 0.5));
          c += vec3(0.30, 0.36, 0.42) * exp(-abs(h) * 160.0) * 0.55; // the horizon line
          // Glow around the sun, warmer and wider when it is low (twilight colours near the horizon)
          float toSun = max(dot(dir, normalize(sunDir)), 0.0);
          float low = 1.0 - smoothstep(0.0, 0.35, sunDir.z);
          float near = smoothstep(-0.25, 0.05, sunDir.z); // no glow with the sun far below the horizon
          c += near * (vec3(1.0, 0.85, 0.6) * pow(toSun, 24.0) * 0.6 + vec3(0.9, 0.45, 0.2) * low * pow(toSun, 4.0) * 0.35 * (1.0 - abs(h)));
          gl_FragColor = vec4(mix(c, vec3(0.0), space), 1.0);
        }`,
    })),
  );
  dome.renderOrder = -20;
  dome.frustumCulled = false;

  skyGroup.add(dome);
}
scene.add(skyGroup);
const sun = new THREE.DirectionalLight(0xffffff, 1.8);
sun.position.set(-1, -1.5, 3);
scene.add(sun);

// The sun at the shown time (Appearance → Sun): a disc with a glow, infinitely far away like the sky, and the
// light from its direction. Without it the light comes from a fixed direction, as before.
const sunGroup = new THREE.Group();
sunGroup.visible = false;
{
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,245,1)');
  g.addColorStop(0.12, 'rgba(255,248,220,1)');
  g.addColorStop(0.2, 'rgba(255,220,150,0.55)');
  g.addColorStop(0.45, 'rgba(255,190,110,0.15)');
  g.addColorStop(1, 'rgba(255,170,90,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const disc = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, depthWrite: false, fog: false, transparent: true, blending: THREE.AdditiveBlending, // depth-tested: the globe hides it
  }));
  disc.renderOrder = -18; // after the sky and the stars, before everything else
  disc.frustumCulled = false;
  sunGroup.add(disc);
}
scene.add(sunGroup);
const DEFAULT_LIGHT = new THREE.Vector3(-1, -1.5, 3);

// The stars of the Yale Bright Star Catalogue up to magnitude 5, where they are at the shown time (with the sky).
// Like the sky they are infinitely far away (centred on the camera), but not turned with the local horizon:
// their directions are in the scene's frame. Below the horizon they are hidden, except far out in space; by
// day they fade out. Size and brightness follow the magnitude, the colour the star's temperature.
const celestialGroup = new THREE.Group();
celestialGroup.visible = false;
const starUniforms = { up: { value: new THREE.Vector3(0, 0, 1) }, space: { value: 0 }, fade: { value: 1 }, pixelRatio: { value: 1 } };
const starNameLabels = [];

// A small text sprite on the sky: constant angular size, as everything in the camera-centred groups
function makeSkyLabel(text) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const fs = 36;
  ctx.font = `${fs}px system-ui, sans-serif`;
  c.width = Math.ceil(ctx.measureText(text).width) + 8;
  c.height = fs + 10;
  ctx.font = `${fs}px system-ui, sans-serif`;
  ctx.fillStyle = '#b8c8da';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 4, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false, transparent: true, fog: false, opacity: 0.8 }));
  const h = 0.011; // about 0.6° high
  sprite.scale.set((h * c.width) / c.height, h, 1);
  sprite.center.set(-0.08, 0.5); // just right of the star
  sprite.renderOrder = -18;
  return sprite;
}

{
  const n = STARS.length / 4;
  const size = new Float32Array(n), colour = new Float32Array(n * 3);
  // Approximate colour of a star of temperature T (K): red below ~3500 K, white near 6500 K, blue above
  const starColour = (t) => {
    const k = Math.min(Math.max(t, 2500), 30000);
    const r = k < 6600 ? 1 : Math.max(0.62, 1.29 * (k / 6600) ** -0.133);
    const g = k < 6600 ? Math.min(1, 0.39 * Math.log(k / 100) - 0.63) : Math.max(0.72, 1.13 * (k / 6600) ** -0.0755);
    const b = k >= 6600 ? 1 : Math.min(1, 0.54 * Math.log(k / 100 - 10) - 1.2);
    return [r, Math.max(0, g), Math.max(0, b)];
  };
  for (let i = 0; i < n; i++) {
    const mag = STARS[i * 4 + 2];
    size[i] = Math.min(6, Math.max(1.4, 4.6 - 0.75 * mag)); // pixels: Sirius large, magnitude 5 small
    const c = starColour(STARS[i * 4 + 3] * 100), b = Math.min(1, Math.max(0.3, 1.25 - 0.17 * mag));
    colour.set([c[0] * b, c[1] * b, c[2] * b], i * 3);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3)); // set by updateStars
  geom.setAttribute('size', new THREE.BufferAttribute(size, 1));
  geom.setAttribute('colour', new THREE.BufferAttribute(colour, 3));
  const stars = new THREE.Points(geom, new THREE.ShaderMaterial({
    uniforms: starUniforms,
    transparent: true, // drawn after the opaque scene, depth-tested so the globe hides the stars behind it
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float size;
      attribute vec3 colour;
      uniform vec3 up;
      uniform float space, fade, pixelRatio;
      varying vec3 vColour;
      varying float vAlpha;
      void main() {
        // Above the local horizon, or anywhere far out in space; fading out by day
        float above = max(space, smoothstep(-0.02, 0.03, dot(normalize(position), up)));
        vAlpha = above * max(fade, space);
        vColour = colour;
        gl_PointSize = size * pixelRatio;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vColour;
      varying float vAlpha;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0; // round, soft-edged points
        float a = vAlpha * (1.0 - smoothstep(0.4, 1.0, r));
        if (a < 0.01) discard;
        gl_FragColor = vec4(vColour * a, a);
      }`,
  }));
  stars.renderOrder = -19;
  stars.frustumCulled = false;
  celestialGroup.add(stars);
  // Names of the well-known stars (Star names)
  for (const [i, name] of STAR_NAMES) {
    const label = makeSkyLabel(name);
    label.userData.star = i;
    starNameLabels.push(label);
    celestialGroup.add(label);
  }
}
scene.add(celestialGroup);

// The moon (with the sun): a small sphere lit from the direction of the sun, so its phase is right. Shown about
// 2.5× its real size (0.5°), so it can be seen.
const moonMaterial = new THREE.ShaderMaterial({
  uniforms: { sunDir: { value: new THREE.Vector3(0, 0, 1) }, night: { value: 1 } },
  transparent: true,
  depthWrite: false,
  vertexShader: /* glsl */ `
    varying vec3 vNormal;
    void main() {
      vNormal = normal; // the moon is not rotated: object normals are scene directions
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 sunDir;
    uniform float night;
    varying vec3 vNormal;
    void main() {
      float lit = smoothstep(-0.04, 0.06, dot(normalize(vNormal), normalize(sunDir)));
      vec3 c = mix(vec3(0.035, 0.04, 0.05), vec3(0.93, 0.91, 0.86), lit); // the dark part faintly visible (earthshine)
      gl_FragColor = vec4(c, max(lit, night)); // by day the dark part is the blue sky
    }`,
});
const moon = new THREE.Mesh(new THREE.SphereGeometry(0.0115, 32, 16), moonMaterial);
moon.renderOrder = -17;
moon.frustumCulled = false;
sunGroup.add(moon);
const moonState = { dir: null, elevation: null, illuminated: null };
const sunState = { dir: null, elevation: null, azimuth: null };
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
const gridGroup = new THREE.Group(); // the grid cells in use, see buildGridCells
const earthGroup = new THREE.Group(); // the earth surface around the data, see buildEarth
const streamlines = new Streamlines(4000); // moving with the derived wind, see buildStreamlines
dataGroup.add(isoGroup, sliceGroup, mapGroup, boxGroup, volumeGroup, groundGroup, gridGroup, earthGroup, streamlines.object);
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
  requestRender();
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
  dataBounds(tmpBox).getBoundingSphere(tmpSphere);
  const d = camera.position.distanceTo(tmpSphere.center);
  const strength = Number($('hazeAmount').value);
  haze.near = Math.max(0, d - tmpSphere.radius);
  haze.far = haze.near + (2 * tmpSphere.radius) / Math.max(strength, 0.01);
}

// ---------------------------------------------------------------- keyboard flight
// Flies like a plane. While flying the camera has its own attitude, so it can roll, fly upside down and loop;
// the mouse orbit controls are off meanwhile (they would level the view every frame).
//   W/S  throttle (S slows down, past zero backwards)  ↑/↓  pitch: nose up / down (hold ↑ for a loop)
//   ←/→  roll                                   A/D  rudder (yaw)
//   R    level out: wings level, nose to the horizon, keeping the heading
//   Space stop                                  Shift 2× throttle and top speed
// A banked plane turns by itself, more at speed (a coordinated turn). Rotation rates build up and fade
// smoothly. The mouse hands back to orbiting: the view levels and the orbit point goes to the data ahead.

const flyKeys = new Set();
const FLY_CODES = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyR', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space',
]);
const deg = THREE.MathUtils.degToRad;
const FLY = {
  maxSpeed: 0.15, // fraction of the scene extent per second, ×2 with Shift: never fast
  accel: 0.12, // same unit, per second
  maxPitch: deg(25), // per second: gentle, a full loop in about 15 s
  maxRoll: deg(40), // per second
  maxYaw: deg(20), // per second
  response: 2, // per second: how fast the rotation rates follow the keys, and fade after them (a tap is a small correction)
  turnRate: deg(25), // per second: the coordinated turn at 90° bank and full speed
  levelRate: 1.5, // per second, while R is held
};
// active: the plane has the camera; speed in scene units/s; pitch, roll, yaw: rates in rad/s
const flight = { active: false, speed: 0, pitch: 0, roll: 0, yaw: 0, q: new THREE.Quaternion(), targetDistance: 1 };
const flyClock = new THREE.Clock();
const flyTmp = {
  fwd: new THREE.Vector3(), right: new THREE.Vector3(), bodyUp: new THREE.Vector3(), up: new THREE.Vector3(),
  q: new THREE.Quaternion(), level: new THREE.Quaternion(), euler: new THREE.Euler(0, 0, 0, 'XYZ'), m: new THREE.Matrix4(),
  origin: new THREE.Vector3(), move: new THREE.Vector3(),
};
const flightMoving = () => flight.speed !== 0 || flight.pitch !== 0 || flight.roll !== 0 || flight.yaw !== 0;
const stopFlight = () => { flight.speed = flight.pitch = flight.roll = flight.yaw = 0; };

// The local vertical at the camera: +z, on the globe away from the Earth's centre
function localUp(out) {
  if (!globe) return out.set(0, 0, 1);
  return out.copy(camera.position).sub(skyTmp.centre.fromArray(globe.centre)).normalize();
}

// Fly around (view bar): the camera circles the centre of the data, rising and sinking a little, one turn per
// TOUR.period seconds. While the animation plays it is driven by it: it moves on only while the shown time moves
// forward (not while a time is loading, or when the loop wraps), at the pace of the chosen frame time; without
// an animation it circles in real time. On starting it moves smoothly to
// a distance where all the data is in view (or stays further out) at a moderate elevation; after that, dragging
// and zooming change the circle and it goes on from there.
const TOUR = { period: 120, bob: THREE.MathUtils.degToRad(6), bobPeriod: 40, settle: 3 };
const tour = { active: false, time: 0, settle: 0, distance: 0, elevation: 0, shown: null };

// Seconds of circling since the previous frame: without an animation the real time (dt); while animating the
// shown time that passed, at the pace of the animation (frame time per time step), 0 when it did not move forward
function tourProgress(dt) {
  const t = skyTime(), last = tour.shown;
  tour.shown = t;
  if (!anim.playing) return dt;
  if (last == null || !(t > last)) return 0;
  // The length of the time step being played (runs can go from hourly to 3- or 6-hourly)
  const { ms } = timelineTimes();
  let i = 0;
  while (i < ms.length - 2 && ms[i + 1] <= last) i++;
  const step = ms.length > 1 ? Math.abs(ms[i + 1] - ms[i]) || 3600000 : 3600000;
  return Math.min(((t - last) / step) * (Number($('vcSpeed').value) / 1000), 0.25); // at most a quarter second at once
}
const tourTmp = { off: new THREE.Vector3(), z: new THREE.Vector3(0, 0, 1), center: new THREE.Vector3() };

function startTour() {
  if (!state.geo) return;
  endFlight();
  // Most of the Earth: spinning around it about its axis, near the equator; otherwise circling the data
  const earth = earthCentred();
  if (earth) setOrbitUp(northAxis());
  const sphere = dataBounds(tmpBox).getBoundingSphere(tmpSphere);
  const fit = earth ? earthFitDistance() : fitDistance(sphere.radius);
  const center = earth ? new THREE.Vector3(...globe.centre) : sphere.center;
  const off = toAxisFrame(tourTmp.off.copy(camera.position).sub(controls.target));
  const r = off.length() || fit;
  const el = Math.asin(THREE.MathUtils.clamp(off.z / r, -1, 1));
  Object.assign(tour, {
    active: true, time: 0, settle: 0, shown: null, earth,
    distance: Math.max(r, fit),
    elevation: earth
      ? THREE.MathUtils.clamp(el, THREE.MathUtils.degToRad(-12), THREE.MathUtils.degToRad(18))
      : THREE.MathUtils.clamp(el, THREE.MathUtils.degToRad(15), THREE.MathUtils.degToRad(45)),
  });
  tourTmp.center.copy(center);
  requestRender();
}

// Distance at which a sphere of radius r around the target is all in view, and the whole Earth with its data
function fitDistance(r) {
  const halfFov = THREE.MathUtils.degToRad(camera.fov / 2);
  return (r * 1.1) / Math.sin(Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect)));
}
function earthFitDistance() {
  return fitDistance((EARTH_RADIUS + Math.max(0, state.geo.zmax * globe.vscale)) * 1.25); // with room for the axis
}
// Offsets in a frame with z along the camera's up (the scene's z, or the Earth's axis) and back
const axisQ = new THREE.Quaternion();
const toAxisFrame = (v) => v.applyQuaternion(axisQ.setFromUnitVectors(camera.up, SCENE_Z));
const fromAxisFrame = (v) => v.applyQuaternion(axisQ.setFromUnitVectors(SCENE_Z, camera.up));

function stopTour() {
  tour.active = false;
  $('vcTour').checked = false;
}

// Moves the camera along the circle; true while touring (so the view keeps being drawn)
function updateTour(dt) {
  if (!tour.active || flight.active || !state.geo) return false;
  const progress = tourProgress(dt);
  if (!progress && tour.settle >= 1) return false; // the animation stands still: so does the camera
  const prevTime = tour.time;
  tour.time += progress;
  const off = toAxisFrame(tourTmp.off.copy(camera.position).sub(controls.target)); // z along the camera's up
  let r = off.length();
  let az = Math.atan2(off.x, off.y), el = Math.asin(THREE.MathUtils.clamp(off.z / r, -1, 1));
  // Settling in: towards the centre of the data, the distance and elevation chosen at the start
  if (tour.settle < 1) {
    tour.settle = Math.min(1, tour.settle + dt / TOUR.settle);
    const k = 1 - Math.exp(-dt * 2.5);
    controls.target.lerp(tourTmp.center, k);
    r += (tour.distance - r) * k;
    el += (tour.elevation - el) * k;
  }
  // Around, and a little up and down
  az -= ((2 * Math.PI) / TOUR.period) * progress;
  const w = (2 * Math.PI) / TOUR.bobPeriod;
  el += TOUR.bob * (Math.sin(tour.time * w) - Math.sin(prevTime * w));
  el = tour.earth
    ? THREE.MathUtils.clamp(el, THREE.MathUtils.degToRad(-80), THREE.MathUtils.degToRad(80))
    : THREE.MathUtils.clamp(el, THREE.MathUtils.degToRad(2), THREE.MathUtils.degToRad(85));
  off.set(r * Math.cos(el) * Math.sin(az), r * Math.cos(el) * Math.cos(az), r * Math.sin(el));
  camera.position.copy(controls.target).add(fromAxisFrame(off));
  return true;
}

function startFlight() {
  if (flight.active || !state.geo) return;
  if (tour.active) stopTour(); // the keys take over
  flight.active = true;
  controls.enabled = false;
  flight.q.copy(camera.quaternion);
  flight.targetDistance = Math.max(camera.position.distanceTo(controls.target), state.geo.ext * 0.05);
}

// Back to the mouse: the orbit point goes to where the line of sight passes closest to the centre of the data
// (after flying it would otherwise be far beyond it), and the orbit controls take over, which levels the view
const handoverTmp = { dir: new THREE.Vector3(), center: new THREE.Vector3() };
function endFlight() {
  if (!flight.active) return;
  stopFlight();
  flight.active = false;
  const { dir, center } = handoverTmp;
  dir.set(0, 0, -1).applyQuaternion(camera.quaternion);
  dataBounds(tmpBox).getCenter(center);
  const along = center.sub(camera.position).dot(dir);
  const distance = along > state.geo.ext * 0.02 ? along : state.geo.ext * 0.3;
  controls.target.copy(camera.position).addScaledVector(dir, distance);
  controls.enabled = true;
  requestRender();
}
// Capture phase: before OrbitControls sees the event, so the same drag or wheel already orbits
for (const type of ['pointerdown', 'wheel']) canvas.addEventListener(type, () => endFlight(), { capture: true, passive: true });

const isTyping = (el) => el && (el.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
window.addEventListener('keydown', (e) => {
  if (!FLY_CODES.has(e.code) || isTyping(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space') {
    // Space stops the flight; it must not also press a focused button such as play
    if (document.activeElement?.tagName === 'BUTTON') document.activeElement.blur();
    stopFlight();
  } else {
    flyKeys.add(e.code);
    if (!e.code.startsWith('Shift')) startFlight();
  }
  e.preventDefault(); // arrow keys and space would scroll the panel
});
window.addEventListener('keyup', (e) => flyKeys.delete(e.code));
window.addEventListener('blur', () => flyKeys.clear());
// Clicking the view takes the focus from panel fields, so the flight keys work right away
canvas.addEventListener('pointerdown', () => { if (isTyping(document.activeElement)) document.activeElement.blur(); });

// One step of the plane: throttle, rotation rates, coordinated turn, levelling, then move along the nose
function fly(dt) {
  if (!flight.active || !state.geo) return;
  const k = (code) => (flyKeys.has(code) ? 1 : 0);
  if (!flyKeys.size && !flightMoving()) return;
  const boost = k('ShiftLeft') || k('ShiftRight') ? 2 : 1;
  const ext = state.geo.ext, max = ext * FLY.maxSpeed * boost, a = ext * FLY.accel * boost;
  const throttle = k('KeyW') - k('KeyS');
  // Past zero the plane flies backwards, up to the same top speed
  if (throttle) flight.speed = THREE.MathUtils.clamp(flight.speed + throttle * a * dt, -max, max);
  else if (Math.abs(flight.speed) > max) flight.speed = Math.sign(flight.speed) * (max + (Math.abs(flight.speed) - max) * Math.exp(-dt)); // after Shift: back to the top speed
  // Rates follow the keys smoothly, and fade without them
  const f = 1 - Math.exp(-FLY.response * dt);
  // Like a flight stick: ↑ (pushing forward) puts the nose down, ↓ (pulling back) up
  flight.pitch += ((k('ArrowDown') - k('ArrowUp')) * FLY.maxPitch - flight.pitch) * f;
  flight.roll += ((k('ArrowLeft') - k('ArrowRight')) * FLY.maxRoll - flight.roll) * f;
  flight.yaw += ((k('KeyA') - k('KeyD')) * FLY.maxYaw - flight.yaw) * f;
  for (const key of ['pitch', 'roll', 'yaw']) if (Math.abs(flight[key]) < 1e-4) flight[key] = 0;

  const { fwd, right, up, q, level, euler, m, origin } = flyTmp;
  const att = flight.q;
  // Body rotations, about the camera's own axes: x pitch (nose up), y yaw (nose left), z roll (left wing down)
  att.multiply(q.setFromEuler(euler.set(flight.pitch * dt, flight.yaw * dt, flight.roll * dt)));
  // Coordinated turn: a banked plane turns towards the lower wing, more at speed; not when stopped, and the
  // other way when flying backwards, like a car reversing
  localUp(up);
  right.set(1, 0, 0).applyQuaternion(att);
  const sinBank = -right.dot(up); // > 0: right wing down
  const turn = FLY.turnRate * sinBank * THREE.MathUtils.clamp(flight.speed / (ext * FLY.maxSpeed), -1, 1);
  if (turn) att.premultiply(q.setFromAxisAngle(up, -turn * dt));
  // R: level out, wings level and nose to the horizon, keeping the heading
  if (k('KeyR')) {
    fwd.set(0, 0, -1).applyQuaternion(att);
    fwd.addScaledVector(up, -fwd.dot(up)); // the heading in the horizontal plane
    if (fwd.lengthSq() < 1e-6) {
      // Straight up or down: level out towards where the top of the plane points
      fwd.set(0, 1, 0).applyQuaternion(att);
      fwd.addScaledVector(up, -fwd.dot(up));
    }
    level.setFromRotationMatrix(m.lookAt(origin.set(0, 0, 0), fwd.normalize(), up));
    att.slerp(level, 1 - Math.exp(-FLY.levelRate * dt));
  }
  att.normalize();
  camera.quaternion.copy(att);
  fwd.set(0, 0, -1).applyQuaternion(att);
  camera.position.addScaledVector(fwd, flight.speed * dt);
  controls.target.copy(camera.position).addScaledVector(fwd, flight.targetDistance); // for when the mouse takes over
}

// Position, height, speed and heading while flying, at the bottom right of the view
let flightInfoAt = 0, flightIdleSince = 0;
function updateFlightInfo(now) {
  const el = $('flightInfo');
  const moving = flight.active && (flyKeys.size > 0 || flightMoving());
  if (moving) flightIdleSince = 0;
  else if (!flightIdleSince) flightIdleSince = now;
  const show = !!state.geo && (moving || now - flightIdleSince < 1500);
  el.classList.toggle('visible', show);
  if (!show || now - flightInfoAt < 100) return; // about ten updates a second is plenty
  flightInfoAt = now;
  const g = state.grid, { lon0, lat0, kx, ky, levelSpacing } = state.geo;
  const p = camera.position;
  let lon, lat, z;
  if (globe) {
    ({ lon, lat, height: z } = globe.unplace(p.x, p.y, p.z));
  } else {
    const x = lon0 + p.x / kx, y = lat0 + p.y / ky; // grid coordinates: lon/lat, or rotated on a native grid
    [lon, lat] = g.proj ? g.proj.toGeo(x, y) : [x, y];
    z = p.z / vscale();
  }
  let height;
  if (g.vkind === 'pressure' || g.vkind === 'height' || (g.vmode === 'pressure' && g.data[g.pressureParam])) height = `${fmt(z / KM_SCALE, 2)} km`;
  else {
    // Level index from the height; levels are evenly spaced in the scene, extrapolated above and below the box
    const f = (g.nz - 1) - z / Math.max(levelSpacing, 1e-9);
    const step = g.nz > 1 ? g.levels[1] - g.levels[0] : 1;
    const level = g.levels[0] + f * step;
    height = level < g.levels[0] ? `above level ${g.levels[0]}` : level > g.levels.at(-1) ? `below level ${g.levels.at(-1)}` : `level ${fmt(level, 1)}`;
  }
  // Attitude of the plane: heading, pitch and bank (±180° upside down), from its axes and the local vertical
  const up = localUp(flyTmp.up), fwd = flyTmp.fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = flyTmp.right.set(1, 0, 0).applyQuaternion(camera.quaternion), bodyUp = flyTmp.bodyUp.set(0, 1, 0).applyQuaternion(camera.quaternion);
  const heading = (THREE.MathUtils.radToDeg(Math.atan2(fwd.x, fwd.y)) + 360) % 360;
  const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(fwd.dot(up), -1, 1)));
  const bank = THREE.MathUtils.radToDeg(Math.atan2(-right.dot(up), bodyUp.dot(up)));
  const speed = flight.speed; // scene units are km horizontally
  el.innerHTML = `${fmt(Math.abs(lat), 3)}°${lat >= 0 ? 'N' : 'S'} ${fmt(Math.abs(lon), 3)}°${lon >= 0 ? 'E' : 'W'} · ${height}<br>` +
    `speed <b>${fmt(Math.abs(speed), Math.abs(speed) < 10 ? 2 : 1)} km/s</b>${speed < 0 ? ' backwards' : ''} · heading ${fmt(heading, 0)}°${g.proj ? ' (grid)' : ''}<br>` +
    `pitch ${fmt(pitch, 0)}° · bank ${fmt(bank, 0)}°${Math.abs(bank) > 90 ? ' (upside down)' : ''}`;
}

// On the globe the camera can go from near the data to far out in space: the far plane must stay beyond the
// whole Earth, and the near plane grows with the distance so the depth buffer keeps its precision
function fitClipPlanes() {
  const toCentre = camera.position.distanceTo(skyTmp.centre.fromArray(globe.centre));
  const far = toCentre + EARTH_RADIUS * 1.5;
  const near = Math.max(1, Math.min(far / 2000, Math.max(toCentre - EARTH_RADIUS * 1.2, 0) * 0.02 + 2));
  if (Math.abs(camera.far - far) > far * 0.01 || Math.abs(camera.near - near) > near * 0.05) {
    camera.far = far;
    camera.near = near;
    camera.updateProjectionMatrix();
  }
}

// On the globe the sky's horizon follows the local vertical at the camera, and fades to black space with stars all
// around as the camera gets far above the Earth. Flat: the horizon is horizontal, as before. The stars, sun and
// moon are not turned with it (they are in the scene's frame); they are hidden below the local horizon.
const skyTmp = { up: new THREE.Vector3(), z: new THREE.Vector3(0, 0, 1), q: new THREE.Quaternion(), sun: new THREE.Vector3(), centre: new THREE.Vector3(), p: new THREE.Vector3() };
function updateSkyObjects() {
  const u = skyDomeMaterial.uniforms;
  let space = 0;
  if (globe) {
    skyTmp.up.copy(camera.position).sub(skyTmp.centre.fromArray(globe.centre));
    const altitude = skyTmp.up.length() - EARTH_RADIUS;
    space = THREE.MathUtils.smoothstep(altitude, EARTH_RADIUS * 0.05, EARTH_RADIUS * 0.6);
    skyTmp.up.normalize();
  } else {
    skyTmp.up.set(0, 0, 1);
  }
  const up = skyTmp.up;
  if (skyGroup.visible) {
    skyGroup.position.copy(camera.position); // centred on the camera: infinitely far away
    skyGroup.scale.setScalar(camera.far * 0.9); // inside the far plane
    skyGroup.quaternion.setFromUnitVectors(skyTmp.z, up);
    u.space.value = space;
    // The sun direction in the sky's own (rotated) coordinates
    if (sunState.dir) u.sunDir.value.copy(sunState.dir).applyQuaternion(skyTmp.q.copy(skyGroup.quaternion).invert());
  }
  if (celestialGroup.visible) {
    celestialGroup.position.copy(camera.position);
    celestialGroup.scale.setScalar(camera.far * 0.99); // just inside the far plane, behind everything else
    starUniforms.up.value.copy(up);
    starUniforms.space.value = space;
    starUniforms.pixelRatio.value = renderer.getPixelRatio();
    // Names: of stars above the horizon (or anywhere in space), fading out by day like the stars
    const names = $('starNamesOn').checked, fade = Math.max(space, starUniforms.fade.value);
    for (const label of starNameLabels) {
      const above = label.position.dot(up) > 0;
      label.visible = names && fade > 0.15 && (above || space > 0.5);
      label.material.opacity = 0.8 * fade;
    }
  }
  if (sunGroup.visible) {
    sunGroup.position.copy(camera.position);
    sunGroup.scale.setScalar(camera.far * 0.97);
    // Below the local horizon the sun and moon are hidden, except far out in space (there the globe hides them)
    const disc = sunGroup.children[0];
    if (sunState.dir) disc.visible = space > 0.5 || sunState.dir.dot(up) > -0.06;
    if (moonState.dir) moon.visible = space > 0.5 || moonState.dir.dot(up) > -0.02;
    moonMaterial.uniforms.night.value = Math.max(space, starUniforms.fade.value);
  }
}

// Drawing only when something changes, so an idle view costs (almost) nothing. Things that change the scene
// call requestRender; camera motion, flying, banking and streamlines keep drawing while they are active.
function requestRender(frames = 2) {
  renderFrames = Math.max(renderFrames, frames);
}
// Any input in the page can change what is shown (sliders, checkboxes, menus, keys)
for (const type of ['input', 'change', 'click', 'keydown', 'keyup']) document.addEventListener(type, () => requestRender(), true);
controls.addEventListener('change', () => requestRender());

// Frame rate (Appearance → Frame rate): frames drawn per second, the longest gap between two frames (a stutter
// shows up there) and the page's own time per frame, over half a second. The view is drawn on demand: idle when
// nothing has been drawn for a while.
const fpsStats = { frames: 0, since: performance.now(), last: 0, worst: 0, js: 0, shownIdle: false, drawing: false };
// wasDrawing: the previous display frame was drawn too, so the gap is a stutter, not a pause after idling
function countFrame(start, end, wasDrawing) {
  const s = fpsStats;
  if (wasDrawing) s.worst = Math.max(s.worst, start - s.last);
  s.last = start;
  s.drawing = true;
  s.frames++;
  s.js += end - start;
}
function updateFps(now) {
  const s = fpsStats, el = $('fps');
  el.hidden = !$('fpsOn').checked;
  if (el.hidden || now - s.since < 500) return;
  if (s.frames) {
    const fps = (s.frames * 1000) / (now - s.since);
    el.innerHTML = `<b>${fps.toFixed(0).padStart(3)}</b> fps · worst <span class="${s.worst > 50 ? 'slow' : ''}">${s.worst.toFixed(0).padStart(3)} ms</span> · cpu ${(s.js / s.frames).toFixed(1).padStart(4)} ms`;
    s.shownIdle = false;
  } else if (!s.shownIdle && now - s.last > 1000) {
    el.innerHTML = '<b>idle</b> · drawn when something changes';
    s.shownIdle = true;
  }
  Object.assign(s, { frames: 0, since: now, worst: 0, js: 0 });
}

renderer.setAnimationLoop((now) => {
  const frameStart = performance.now(), wasDrawing = fpsStats.drawing;
  fpsStats.drawing = false; // until this frame is drawn
  updateFps(frameStart);
  const dt = Math.min(flyClock.getDelta(), 0.1); // capped, so a stalled frame does not jump far
  fly(dt);
  const touring = updateTour(dt);
  const cameraMoved = flight.active ? false : controls.update(); // while flying the plane has the camera
  updateFlightInfo(now);
  streamlines.update(dt);
  const skyMoving = advanceSkyClock(now);
  const flying = flight.active && (flyKeys.size > 0 || flightMoving());
  if (!(cameraMoved || touring || flying || skyMoving || streamlines.object.visible || pickPending || renderFrames > 0)) return;
  if (renderFrames > 0) renderFrames--;
  if (globe) fitClipPlanes();
  updateSkyObjects();
  updateHaze();
  if (state.volume && volumeGroup.visible) updateVolumeCamera(state.volume.mesh, camera);
  if (pickPending) {
    pickPending = false;
    pick();
  }
  renderer.render(scene, camera);
  updatePlayhead();
  countFrame(frameStart, performance.now(), wasDrawing);
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
  return s === 'C' ? '°C' : s && s !== 'unknown' && s !== '-^-' ? s : '';
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
  requestRender(); // every rebuild of scene content starts here
  for (const o of [...group.children]) {
    group.remove(o);
    o.geometry?.dispose();
    if (o.material && o.material !== sliceMaterial) {
      if (!Object.values(state.mapTex).some((entry) => entry.tex === o.material.map)) o.material.map?.dispose();
      o.material.dispose();
    }
  }
}

// ---------------------------------------------------------------- metadata

async function loadCollection(collectionUrl, prefer = {}) {
  stopAnimation(); // its list of times belongs to the old collection
  setStatus('Loading collection metadata…');
  const url = collectionUrl.trim().replace(/\/+$/, '');
  state.collection = await fetchJSON(url);
  state.collectionUrl = url;
  const sel = $('parameter');
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(state.collection.parameter_names || {})) {
    const unit = paramUnit(id);
    sel.append(option(id, `${p.label || id}${unit ? ` [${unit}]` : ''}`));
  }
  const wind = windPairOf(state.collection);
  if (wind) {
    const unit = paramUnit(wind.speed);
    sel.append(option(WIND_OPTION, `Wind: speed + direction, with streamlines${unit ? ` [${unit}]` : ''}`));
  }
  if (prefer.parameter) {
    // Servers spell the same parameter as wind_speed_ml or wind-speed-ml
    const norm = (id) => id.toLowerCase().replace(/[-_]/g, '');
    const match = Object.keys(state.collection.parameter_names || {}).find((id) => norm(id) === norm(prefer.parameter));
    if (match) sel.value = match;
  }

  state.native = nativeCubeCrs(state.collection);
  const csel = $('gridCrs');
  csel.innerHTML = '';
  csel.append(option('', 'EPSG:4326 (resampled to lon/lat)'));
  if (state.native) {
    const { crs, proj } = state.native;
    csel.append(option(crs, `${crs}: rotated pole (lon_0 ${proj.lon0}, o_lat_p ${proj.oLatP}), no resampling`));
  }
  // Native grid by default when offered; an explicit EPSG:4326 / CRS84 (or '') keeps lon/lat.
  csel.value = state.native && (prefer.crs == null || prefer.crs === state.native.crs) ? state.native.crs : '';
  csel.disabled = !state.native;
  syncViewControls();

  const previousKind = state.vertical?.kind, previousValues = state.vertical?.values.join();
  state.vertical = verticalOf(state.collection);
  const vals = state.vertical.values;
  if (vals.length) {
    for (const id of ['levelFrom', 'levelTo']) {
      $(id).min = Math.min(...vals);
      $(id).max = Math.max(...vals);
    }
    // Another set of levels (e.g. pressure instead of model levels): select all of them
    if (previousKind !== state.vertical.kind || previousValues !== vals.join()) {
      $('levelFrom').value = Math.min(...vals);
      $('levelTo').value = Math.max(...vals);
    }
  }
  // Pressure-altitude placement is for model levels; pressure and height levels are placed by their value
  $('vmode').disabled = state.vertical.kind !== 'level';
  $('vmode').title = state.vertical.kind !== 'level' ? `The ${state.vertical.label} are placed at their height` : '';

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
  showCollectionNeighbours(url); // in the background
  instanceDocs.clear(); // a reloaded collection can have new or longer runs
  await updateDatetimes(prefer.datetime);
}

// Instance documents by URL. The /instances list of the KNMI server gives every run the same times, so the
// times come from the document of the instance itself (…/instances/{id}), which has the right ones.
const instanceDocs = new Map();

async function instanceTimes(instanceId) {
  const listed = state.instances.find((i) => i.id === instanceId);
  if (!listed) return parseTemporalValues(state.collection?.extent?.temporal?.values || []);
  const url = `${state.collectionUrl}/instances/${encodeURIComponent(instanceId)}`;
  if (!instanceDocs.has(url)) {
    try {
      instanceDocs.set(url, await fetchJSON(url, { retries: 0 }));
    } catch (e) {
      console.warn('Could not read instance document, using the instance list', e);
      instanceDocs.set(url, listed);
    }
  }
  const doc = instanceDocs.get(url);
  const times = parseTemporalValues((doc?.extent?.temporal?.values ? doc : listed)?.extent?.temporal?.values || []);
  // A run does not forecast its own past. The KNMI server sometimes gives a run (e.g. the newest, while it is
  // being published) the times of the whole collection, starting days before the run: drop those, if any remain.
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(instanceId);
  if (!m) return times;
  const runTime = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const ahead = times.filter((t) => Date.parse(t) > runTime);
  return ahead.length ? ahead : times;
}

// Fills the time list for the selected instance. Loads wait for state.timesReady, so they never combine a run
// with a time of the previous run while its times are still being read.
function updateDatetimes(prefer) {
  const sel = $('datetime');
  const keep = prefer ? toIso(Date.parse(prefer)) : sel.value;
  if (!instanceDocs.has(`${state.collectionUrl}/instances/${encodeURIComponent($('instance').value)}`) && state.instances.length) {
    sel.innerHTML = '';
    sel.append(option('', 'loading times…'));
    syncViewControls();
  }
  state.timesReady = fillDatetimes(keep);
  return state.timesReady;
}

async function fillDatetimes(current) {
  const instanceId = $('instance').value;
  const times = await instanceTimes(instanceId);
  if ($('instance').value !== instanceId) return; // another instance was chosen meanwhile
  const sel = $('datetime');
  sel.innerHTML = '';
  for (const t of times) sel.append(option(t, t.replace('T', ' ').replace(':00Z', 'Z')));
  if (times.includes(current)) sel.value = current;
  syncViewControls();
}

// ---------------------------------------------------------------- loading

function readBBox() {
  const b = ['bboxW', 'bboxS', 'bboxE', 'bboxN'].map((id) => Number($(id).value));
  if (b.some((v) => !Number.isFinite(v)) || b[0] >= b[2] || b[1] >= b[3]) throw new Error('Invalid bounding box');
  return b;
}

// What the scene geometry depends on, apart from the values: when this is unchanged the camera can stay
const viewKey = (g) => [g.lons[0], g.lons.at(-1), g.lats[0], g.lats.at(-1), g.nx, g.ny, g.levels[0], g.levels.at(-1), g.vmode, g.crs].join();

// The cube request for the panel settings, optionally for another time. Throws on invalid input.
function buildRequest(datetime = $('datetime').value) {
  const selection = $('parameter').value;
  // Derived wind: speed is the field shown, the direction comes along for the streamlines
  const wind = selection === WIND_OPTION ? windPairOf(state.collection) : null;
  if (selection === WIND_OPTION && !wind) throw new Error('This collection has no wind speed and direction');
  const param = wind ? wind.speed : selection;
  const vmode = $('vmode').value;
  const pressureParam = pressureParamOf(state.collection);
  const pressureMode = vmode === 'pressure' && (state.vertical?.kind ?? 'level') === 'level';
  const params = [param, ...(wind ? [wind.dir] : []), ...(pressureMode && param !== pressureParam ? [pressureParam] : [])];
  const crs = $('gridCrs').value;
  const proj = crs && state.native?.crs === crs ? state.native.proj : null;
  const levelFrom = Number($('levelFrom').value), levelTo = Number($('levelTo').value);
  if (!(levelFrom <= levelTo)) throw new Error('Level from must be ≤ level to');
  // The collection's level values within the range (top first), every n-th with a vertical step
  const vertical = state.vertical?.values.length ? state.vertical : { kind: 'level', values: [] };
  const levelStep = Number($('levelStep').value) || 1;
  const inRange = vertical.values.length
    ? vertical.values.filter((v) => v >= levelFrom && v <= levelTo)
    : Array.from({ length: Math.round(levelTo) - Math.round(levelFrom) + 1 }, (_, n) => Math.round(levelFrom) + n);
  const levels = inRange.filter((_, n) => n % levelStep === 0);
  if (!levels.length) throw new Error(`No ${vertical.label || 'levels'} between ${levelFrom} and ${levelTo}`);
  // The panel bbox is lon/lat; with a native crs the request bbox must be in native (rotated) coordinates
  const bbox = proj ? bboxToRot(proj, readBBox()) : readBBox();
  const stride = $('stride').value === 'auto' ? 'auto' : Number($('stride').value);
  const opts = {
    collectionUrl: state.collectionUrl || $('collectionUrl').value.trim(),
    instance: $('instance').value,
    datetime,
    bbox,
    crs: crs || undefined,
    levelFrom, levelTo, params, levels, levelStep,
    allLevels: vertical.values.length ? vertical.values : inRange,
    levelsPerRequest: Number($('levelsPerRequest').value) || 5,
    stride,
    fixScale: $('fixScale').value,
    concurrency: Number($('concurrency').value) || 6,
    angleParams: wind ? [wind.dir] : [], // averaged as unit vectors with a horizontal step
    resolution: serverResolution() ?? nativeResolution(proj, bbox, stride),
  };
  const vkind = vertical.kind, vmodeUsed = vkind === 'level' ? vmode : 'level';
  const meta = { param, selection, wind, vmode: vmodeUsed, vkind, pressureParam, crs, proj, unit: paramUnit(param), datetime, instance: opts.instance };
  return { opts, meta, key: JSON.stringify([opts.collectionUrl, opts.instance, datetime, opts.bbox, opts.crs, levels, params, opts.stride, opts.resolution, opts.fixScale, vmodeUsed]) };
}

// "300x300" (or "300 × 300", "300,300") → [300, 300]; empty → null (the server's own grid)
function serverResolution() {
  const text = $('serverResolution').value.trim();
  if (!text) return null;
  const m = /^(\d+)\s*[x×*, ]\s*(\d+)$/i.exec(text);
  if (!m || +m[1] < 2 || +m[2] < 2) throw new Error(`Server resolution "${text}": use e.g. 300x300, or leave it empty`);
  return [+m[1], +m[2]];
}

// On a native grid of known size, a horizontal step is asked from the server (EDR resolution-x/-y): every n-th
// native cell instead of all of them, so much less to generate, send and parse. A server that does not support it
// sends every cell, and loadCube averages them as before. null: no step, or the native grid size is unknown.
function nativeResolution(proj, bbox, stride) {
  const native = state.native;
  if (!proj || !native?.bbox || !native?.cellsize) return null;
  const [gx0, gy0, gx1, gy1] = native.bbox, [cx, cy] = native.cellsize;
  const cellsX = Math.ceil((Math.min(bbox[2], gx1) - Math.max(bbox[0], gx0)) / cx - 1e-6);
  const cellsY = Math.ceil((Math.min(bbox[3], gy1) - Math.max(bbox[1], gy0)) / cy - 1e-6);
  if (!(cellsX > 0 && cellsY > 0)) return null;
  const step = stride === 'auto' ? Math.ceil(Math.sqrt((cellsX * cellsY) / MAX_POINTS_PER_LEVEL)) : Math.round(stride);
  return step > 1 ? [Math.ceil(cellsX / step), Math.ceil(cellsY / step)] : null;
}

// Loaded cubes, so animating or stepping back to a time does not load it again. Oldest used are dropped first.
const FRAME_CACHE_BYTES = 1024 * 1024 * 1024;
const frameCache = new Map(); // key → grid, in order of use
const framesLoading = new Map(); // key → promise of grid
let frameCacheBytes = 0;
const gridBytes = (g) => Object.values(g.data).reduce((sum, a) => sum + a.byteLength, 0);

function cachedFrame(key) {
  const grid = frameCache.get(key);
  if (grid) { frameCache.delete(key); frameCache.set(key, grid); }
  return grid;
}

function cacheFrame(key, grid) {
  if (frameCache.has(key)) frameCacheBytes -= gridBytes(frameCache.get(key));
  frameCache.delete(key);
  frameCache.set(key, grid);
  frameCacheBytes += gridBytes(grid);
  for (const [k, g] of frameCache) {
    if (frameCacheBytes <= FRAME_CACHE_BYTES || frameCache.size <= 2) break;
    if (g === state.grid) continue;
    frameCache.delete(k);
    frameCacheBytes -= gridBytes(g);
  }
}

// Cubes are loaded in workers (see cubeworker.js), so downloading and parsing the next times of an animation does
// not make the view stutter. Two of them: one can parse a time while the other downloads the next. Without
// workers (or when one fails to start) the cube is loaded on the main thread as before.
const cubeWorkers = (() => {
  try {
    return [0, 1].map(() => {
      const w = new Worker(new URL('./cubeworker.js', import.meta.url), { type: 'module' });
      w.jobs = new Map(); // id → { resolve, reject, onProgress, onUrl, opts, signal, done }
      w.addEventListener('message', ({ data: m }) => {
        const job = w.jobs.get(m.id);
        if (!job) return;
        if (m.type === 'url') job.onUrl?.(m.url);
        else if (m.type === 'progress') job.onProgress?.(m.progress);
        else if (m.type === 'done') job.done(null, m.grid);
        else if (m.type === 'error') job.done(Object.assign(new Error(m.error.message), m.error));
      });
      // The worker could not be started (e.g. an old cached module): its loads run on the main thread
      w.addEventListener('error', (e) => {
        console.warn('Cube worker failed, loading on the main thread', e.message || e);
        w.failed = true;
        for (const job of w.jobs.values()) loadCube(job.opts, job).then((g) => job.done(null, g), (err) => job.done(err));
      });
      return w;
    });
  } catch (e) {
    console.warn('No cube workers, loading on the main thread', e);
    return [];
  }
})();
let cubeJobId = 0;

// The local cache (Data → Local cache): its limit in bytes, 0 = off; remembered in this browser
const localCacheLimit = () => Number($('localCache').value) * 1024 * 1024;
let cacheInfoQueued = null, storedKeys = new Set(); // the request keys in the local cache
function updateLocalCacheInfo(delay = 300) {
  clearTimeout(cacheInfoQueued);
  cacheInfoQueued = setTimeout(async () => {
    try {
      const { count, bytes, keys } = await frameStoreUsage();
      storedKeys = keys;
      updateLoadBlocks();
      $('localCacheInfo').textContent = count ? `${count} time${count > 1 ? 's' : ''}, ${fmtBytes(bytes)}` : 'empty';
    } catch {
      $('localCacheInfo').textContent = 'not available';
    }
  }, delay);
}

function loadCubeOffThread(opts, { signal, onProgress, onUrl, key } = {}) {
  const workers = cubeWorkers.filter((w) => !w.failed);
  if (!workers.length) return loadCube(opts, { signal, onProgress, onUrl });
  const w = workers.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a)); // the least busy one
  const id = ++cubeJobId;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      w.postMessage({ type: 'abort', id });
      job.done(new DOMException('Aborted', 'AbortError'));
    };
    const job = {
      opts, signal, onProgress, onUrl,
      done: (err, grid) => {
        if (!w.jobs.has(id)) return; // already settled (aborted)
        w.jobs.delete(id);
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(grid);
      },
    };
    w.jobs.set(id, job);
    signal?.addEventListener('abort', onAbort);
    w.postMessage({ type: 'load', id, opts, key, store: { limit: localCacheLimit() } });
  });
}

// While times are loading, the view shows a block per time of the run (see index.html #loadBlocks): filled when
// in memory, partly filled while loading (by the level requests done or the bytes received), framed when shown.
const frameProgress = new Map(); // key → fraction loaded, for the loads running
let loadBlocksQueued = false, loadBlocksHide = null;

function progressFraction(p) {
  switch (p?.phase) {
    case 'levels': return p.total ? p.done / p.total : 0;
    case 'downloading': return p.total ? 0.1 + (0.8 * p.done) / p.total : 0.3;
    case 'parsing': return 0.95;
    default: return 0.03; // waiting for the server
  }
}

function updateLoadBlocks() {
  if (loadBlocksQueued) return;
  loadBlocksQueued = true;
  requestAnimationFrame(() => {
    loadBlocksQueued = false;
    drawLoadBlocks();
  });
}

// The time line stays in view once there are times to show (and while anything loads)
const timelineWanted = () => framesLoading.size > 0 || (!!state.grid && $('datetime').options.length > 1);
function drawLoadBlocks() {
  const el = $('loadBlocks');
  if (timelineWanted()) {
    clearTimeout(loadBlocksHide);
    loadBlocksHide = null;
    el.classList.add('visible');
  } else if (el.classList.contains('visible') && !loadBlocksHide) {
    loadBlocksHide = setTimeout(() => {
      loadBlocksHide = null;
      if (timelineWanted()) drawLoadBlocks();
      else el.classList.remove('visible');
    }, 1500);
  }
  if (!el.classList.contains('visible')) return;
  const times = [...$('datetime').options].map((o) => o.value);
  let keys;
  try {
    keys = timelineKeys(times);
  } catch {
    return; // the panel settings are not valid (yet)
  }
  const row = el.querySelector('.lb-row');
  while (row.children.length < times.length) {
    const b = document.createElement('div');
    b.append(document.createElement('i'));
    row.append(b);
  }
  while (row.children.length > times.length) row.lastChild.remove();
  let loaded = 0, local = 0;
  times.forEach((t, n) => {
    const b = row.children[n], inMemory = frameCache.has(keys[n]), f = frameProgress.get(keys[n]);
    const stored = !inMemory && f == null && storedKeys.has(keys[n]); // in the local cache: there in a moment
    if (inMemory) loaded++;
    if (stored) local++;
    b.className = `lb${inMemory ? ' done' : f != null ? ' loading' : stored ? ' stored' : ''}${t === state.grid?.datetime ? ' current' : ''}${inAnimationLoop(n) ? '' : ' out'}`;
    b.firstChild.style.width = `${inMemory || stored ? 100 : f != null ? Math.round(f * 100) : 0}%`;
  });
  timelineCounts = `${loaded} of ${times.length} times in memory` +
    (local ? `, ${local} more in the local cache` : '') + (framesLoading.size ? ` · loading ${framesLoading.size}` : '');
  updatePlayhead(true);
}

// The request key of every time, for the current panel settings: only the time differs between them, so they are
// derived from the first one (the bar is redrawn on every shown frame)
let keysCache = { base: '', times: '', keys: [] };
function timelineKeys(times) {
  const base = buildRequest(times[0]).key, joined = times.join();
  if (keysCache.base !== base || keysCache.times !== joined) {
    // The key is a JSON array with the time third (see buildRequest); the run's name can equal its first time
    const parts = JSON.parse(base);
    keysCache = { base, times: joined, keys: times.map((t) => { parts[2] = t; return JSON.stringify(parts); }) };
  }
  return keysCache.keys;
}

// ---- Time line: the playhead on the block bar, and scrubbing by clicking or dragging it
// Position u: 0 … number of times - 1, fractional between two times (block n is centred on n).
const scrub = { dragging: false, pending: null, busy: false, target: null, waiting: false };
let timelineCounts = '', timelineLabel = '', timelineMs = { key: '', ms: [] };

function timelineTimes() {
  const opts = $('datetime').options, key = `${opts.length}:${opts[0]?.value}:${opts[opts.length - 1]?.value}`;
  if (timelineMs.key !== key) timelineMs = { key, ms: [...opts].map((o) => Date.parse(o.value)), iso: [...opts].map((o) => o.value) };
  return timelineMs;
}

// The playhead at the shown moment (the sky's clock while animating, so it moves smoothly)
function updatePlayhead(force = false) {
  const el = $('loadBlocks');
  if (!el.classList.contains('visible') && !force) return;
  const { ms } = timelineTimes(), n = ms.length;
  if (!n || !state.grid) return;
  const t = skyTime();
  let u = 0;
  if (scrub.waiting && scrub.target != null) {
    // The touched moment is still loading: the playhead and label are already there
    const { i, f } = timelineMoment(scrub.target);
    el.querySelector('.lb-head').style.left = `${((i + f + 0.5) / n) * 100}%`;
    const at = ms[i] + (f ? f * (ms[i + 1] - ms[i]) : 0);
    el.querySelector('.lb-label').textContent = timelineLabel = `${toIso(Math.round(at / 60000) * 60000).replace('T', ' ').slice(0, 16)}Z · loading… · ${timelineCounts}`;
    return;
  }
  if (t >= ms[n - 1]) u = n - 1;
  else if (t > ms[0]) {
    let i = 0;
    while (i < n - 2 && ms[i + 1] <= t) i++;
    u = i + (t - ms[i]) / (ms[i + 1] - ms[i]);
  }
  el.querySelector('.lb-head').style.left = `${((u + 0.5) / n) * 100}%`;
  const label = `${toIso(Math.round(t / 60000) * 60000).replace('T', ' ').slice(0, 16)}Z · ${timelineCounts}`;
  if (label !== timelineLabel || force) el.querySelector('.lb-label').textContent = timelineLabel = label;
}

// The moment at position u, following the In between setting (off: the nearest time): { i, f } with
// 0 ≤ f < 1 the fraction towards time i + 1
function timelineMoment(u) {
  const { ms } = timelineTimes(), n = ms.length;
  u = THREE.MathUtils.clamp(u, 0, n - 1);
  const mode = Number($('tweenStep').value);
  let i = Math.min(Math.floor(u), n - 1), f = u - i;
  if (mode === 0 || i === n - 1) {
    i = Math.min(Math.round(u), n - 1);
    f = 0;
  } else if (mode > 0) {
    const span = ms[i + 1] - ms[i], q = mode * 60000;
    f = (Math.round((f * span) / q) * q) / span;
    if (f >= 1) { i++; f = 0; }
  }
  return { i, f: f < 1e-4 ? 0 : f };
}

// Times touched on the time line that are not in memory: loaded most recently touched first, at most as many at
// once as "ahead" in the view bar (loads already running count too), so dragging over many does not start them all
const scrubQueue = [];
function queueScrubLoad(time) {
  const at = scrubQueue.indexOf(time);
  if (at >= 0) scrubQueue.splice(at, 1);
  scrubQueue.unshift(time);
  pumpScrubLoads();
}
function pumpScrubLoads() {
  const limit = Number($('vcPrefetch').value) || 1;
  while (scrubQueue.length && framesLoading.size < limit) {
    const time = scrubQueue.shift();
    let request;
    try { request = buildRequest(time); } catch { continue; }
    if (cachedFrame(request.key) || framesLoading.has(request.key)) continue;
    fetchFrame(request)
      .then(() => { if (scrub.target != null) showTimelineAt(scrub.target); }) // shown if it is still wanted
      .catch((e) => { if (e.name !== 'AbortError') console.warn('Could not load', time, e); })
      .finally(pumpScrubLoads);
  }
}

// Shows the moment at position u: a loaded time, or in between two (blended on the GPU when only the volume is
// shown, interpolated on the CPU otherwise). Times not in memory are queued for loading; meanwhile the nearest
// time in memory is shown, and the moment itself when it arrives (if the time line is still there).
function showTimelineAt(u) {
  const { ms, iso } = timelineTimes();
  if (!ms.length) return;
  scrub.target = u;
  const { i, f } = timelineMoment(u);
  const get = (k) => {
    try { return cachedFrame(buildRequest(iso[k]).key) || null; } catch { return null; }
  };
  const a = get(i), b = f > 0 ? get(i + 1) : null;
  if (!a) queueScrubLoad(iso[i]);
  if (f > 0 && !b) queueScrubLoad(iso[i + 1]);
  scrub.waiting = !a || (f > 0 && !b);
  if (scrub.waiting) {
    // Meanwhile the nearest time that is in memory, if any
    const near = f < 0.5 ? (a ? [a, i] : b ? [b, i + 1] : null) : (b ? [b, i + 1] : a ? [a, i] : null);
    if (near && state.grid !== near[0]) {
      $('datetime').value = iso[near[1]];
      showGrid(near[0]);
    }
    setStatus(`Loading ${iso[!a ? i : i + 1]}…`);
    updatePlayhead(true);
    return;
  }
  scrub.target = null;
  $('datetime').value = iso[i];
  if (b && sameShape(a, b)) {
    const time = toIso(Math.round((ms[i] + f * (ms[i + 1] - ms[i])) / 60000) * 60000);
    if (state.grid !== a && canBlendOnGpu()) showGrid(a);
    if (state.grid === a && canBlendOnGpu() && (state.volume?.nextGrid === b || prepareVolumeBlend(b))) setVolumeBlend(f, time);
    else showGrid(interpolateGrid(a, b, f, time));
  } else if (state.grid !== a) {
    showGrid(a);
  } else if (gpuTween) {
    resetVolumeBlend();
    requestRender();
  }
  updateSun({ hud: !f }); // the HUD keeps the loaded time
  setStatus(`Time ${shownTimeOf(state.grid) || iso[i]}${f ? ' (in between)' : ''}`);
  updatePlayhead(true);
}

// Several pointer moves can come in one frame: only the newest position is shown, once per frame
function scrubTo(u) {
  scrub.pending = u;
  if (scrub.busy) return;
  scrub.busy = true;
  requestAnimationFrame(() => {
    scrub.busy = false;
    const next = scrub.pending;
    scrub.pending = null;
    if (next != null) showTimelineAt(next);
  });
}

{
  // Only the blocks scrub: the animation controls share the bar
  const bar = $('loadBlocks'), track = bar.querySelector('.lb-track');
  const positionOf = (e) => {
    const r = bar.querySelector('.lb-row').getBoundingClientRect(), n = timelineTimes().ms.length;
    return ((e.clientX - r.left) / r.width) * n - 0.5;
  };
  track.addEventListener('pointerdown', (e) => {
    if (!bar.classList.contains('visible') || !state.grid) return;
    stopAnimation(); // scrubbing pauses; the loop is kept
    scrub.dragging = true;
    try { track.setPointerCapture(e.pointerId); } catch { /* e.g. a synthetic event: no capture */ }
    scrubTo(positionOf(e));
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => { if (scrub.dragging) scrubTo(positionOf(e)); });
  const end = () => { scrub.dragging = false; };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
}

// The view controls collapse to a small button (remembered in this browser)
function setViewControlsCollapsed(collapsed) {
  $('viewControls').classList.toggle('collapsed', collapsed);
  $('vcCollapse').hidden = collapsed;
  $('vcExpand').hidden = !collapsed;
  try { localStorage.setItem('viewControlsCollapsed', collapsed ? '1' : '0'); } catch { /* not remembered */ }
}
$('vcCollapse').addEventListener('click', () => setViewControlsCollapsed(true));
$('vcExpand').addEventListener('click', () => setViewControlsCollapsed(false));
try { if (localStorage.getItem('viewControlsCollapsed') === '1') setViewControlsCollapsed(true); } catch { /* default: shown */ }

// The grid for a request: from the cache, from a load already running, or loaded now
function fetchFrame({ opts, meta, key }, { signal, onProgress, onUrl } = {}) {
  const grid = cachedFrame(key);
  if (grid) return Promise.resolve(Object.assign(grid, meta)); // the vertical coordinate switch can have changed it
  if (framesLoading.has(key)) return framesLoading.get(key);
  frameProgress.set(key, 0);
  const progress = (p) => {
    frameProgress.set(key, progressFraction(p));
    updateLoadBlocks();
    onProgress?.(p);
  };
  const promise = loadCubeOffThread(opts, { signal, onProgress: progress, onUrl, key })
    .then((grid) => {
      Object.assign(grid, meta);
      cacheFrame(key, grid);
      return grid;
    })
    .finally(() => {
      if (framesLoading.get(key) === promise) {
        framesLoading.delete(key);
        frameProgress.delete(key);
      }
      updateLoadBlocks();
      updateLocalCacheInfo(1000); // after the worker has written it
    });
  framesLoading.set(key, promise);
  updateLoadBlocks();
  return promise;
}

function showGrid(grid) {
  requestRender();
  queueMicrotask(() => updateSun({ hud: !grid.shownTime })); // the sun follows the shown time; the HUD the loaded one
  // Keep the camera when only the time or parameter changed; fit it again for a new area, grid or levels
  const refit = !state.grid || viewKey(state.grid) !== viewKey(grid);
  state.grid = grid;
  rebuildAll();
  if (refit) fitCamera();
  updateLoadBlocks(); // the frame around the shown time
}

// Shows the time of the panel settings: from memory, the local cache or the server (Data → Local cache → Clear
// empties the local cache, so the times are loaded from the server again)
async function loadData() {
  stopAnimation();
  scrub.target = null; // a time chosen in the panel replaces one touched on the time line
  scrub.waiting = false;
  await state.timesReady;
  state.abort?.abort();
  const ac = new AbortController();
  state.abort = ac;
  let request;
  try {
    request = buildRequest();
  } catch (e) {
    setStatus(e.message, true);
    return;
  }
  const { opts } = request;
  const cached = cachedFrame(request.key);
  if (cached) {
    showGrid(Object.assign(cached, request.meta));
    setStatus(`Shown from memory: ${cached.nx}×${cached.ny}×${cached.nz} points at ${opts.datetime}`);
    if (state.abort === ac) state.abort = null;
    return true;
  }

  $('load').disabled = true;
  $('cancel').disabled = false;
  setStatus(`Requesting levels ${opts.levelFrom}–${opts.levelTo}, ${opts.levelsPerRequest} per request…`);
  const loader = startLoader();
  const t0 = performance.now();
  try {
    const grid = await fetchFrame(request, {
      signal: ac.signal,
      onUrl: (u) => { $('requestUrl').href = u; $('requestUrl').textContent = u; },
      onProgress: loader.update,
    });
    loader.update({ phase: 'building' });
    await new Promise((res) => requestAnimationFrame(() => setTimeout(res)));
    if (state.abort !== ac) return; // another load or the animation took over
    showGrid(grid);
    const s = ((performance.now() - t0) / 1000).toFixed(grid.fromStore ? 2 : 1);
    const step = grid.stride > 1 ? ` (${grid.sourceSize.join('×')} averaged ${grid.stride}×${grid.stride})`
      : grid.serverReduced ? ' (fewer cells, chosen by the server)' : '';
    setStatus(`Loaded ${grid.nx}×${grid.ny}×${grid.nz} points${grid.proj ? ' on the native grid' : ''}${step}${grid.fromStore ? ' from the local cache' : ` with ${grid.requests} request${grid.requests > 1 ? 's' : ''}`} in ${s} s` +
      (grid.scaleFixed ? ` (×10 server fix applied to ${grid.scaleFixed} response${grid.scaleFixed > 1 ? 's' : ''})` : ''));
    return true;
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

// ---------------------------------------------------------------- animation over time
// Steps through the times of the instance, wrapping around. The next time is loaded while the current one is
// shown, and every loaded time stays in the frame cache, so the second loop plays from memory.

const anim = { playing: false, abort: null, loop: null }; // loop: { instance, start, n } (indices into the times)

// The animation loop (Loop length in the view bar): n times from start. A new loop starts at the shown time,
// shifted back so it has its full length when the run ends sooner; playing again within the loop keeps it.
const loopSetting = (count) => ($('vcSteps').value === 'all' ? count : Math.min(Number($('vcSteps').value), count));
function animationLoop(times, index) {
  const n = loopSetting(times.length), l = anim.loop;
  const same = l && l.instance === $('instance').value && l.count === times.length;
  if (same && index >= l.start && index < l.start + l.n) return l; // a changed length applies from the same start
  anim.loop = { instance: $('instance').value, count: times.length, start: Math.max(0, Math.min(index, times.length - n)), n };
  return anim.loop;
}
const inAnimationLoop = (i) => {
  const l = anim.loop;
  if (!l || l.instance !== $('instance').value || l.count !== $('datetime').options.length) return true;
  return i >= l.start && i < l.start + l.n;
};

// While animating, the sun, moon and stars do not jump from one time to the next: the sky's time runs smoothly
// from the shown time to the next one during the frame interval, and waits there if the next one is still loading
const skyClock = { from: null, to: null, start: 0, duration: 1, shown: null };
// The time an in-between frame shows: its own (interpolated on the CPU), or the volume's blend (on the GPU)
let gpuTween = null; // { grid, time }: the volume of grid is blended towards the next time
const shownTimeOf = (g) => g?.shownTime || (gpuTween && gpuTween.grid === g ? gpuTween.time : null);

function skyTime() {
  const shown = shownTimeOf(state.grid) || state.grid?.datetime; // an in-between frame has its own time
  const fallback = shown ? Date.parse(shown) : Date.now();
  if (!anim.playing || skyClock.from == null) return fallback;
  const f = THREE.MathUtils.clamp((performance.now() - skyClock.start) / skyClock.duration, 0, 1);
  return skyClock.from + (skyClock.to - skyClock.from) * f;
}
function startSkyClock(time, nextTime, start = performance.now()) {
  const from = Date.parse(time), to = Date.parse(nextTime);
  Object.assign(skyClock, { from, to: to > from ? to : from, start, duration: Math.max(Number($('vcSpeed').value), 50) });
}
const holdSkyClock = (time) => startSkyClock(time, time); // stays at this time until the next step starts

// In between two loaded times (Appearance → In between): every value interpolated linearly, directions along the
// shorter way round. Only for the same grid and parameters; it is shown, not cached.
const sameShape = (a, b) => a && b && a.nx === b.nx && a.ny === b.ny && a.nz === b.nz && a.param === b.param &&
  Object.keys(a.data).every((p) => b.data[p]?.length === a.data[p].length);

// The in-between frames write into two sets of arrays in turn (the one shown and the next), so they do not leave
// megabytes of garbage behind every frame
const tweenBuffers = [{}, {}];
let tweenTurn = 0;
function interpolateGrid(a, b, f, time) {
  const data = {}, buffers = tweenBuffers[(tweenTurn ^= 1)];
  for (const [p, B] of Object.entries(b.data)) {
    const A = a.data[p];
    const out = buffers[p]?.length === B.length ? buffers[p] : (buffers[p] = new Float32Array(B.length));
    if (p === b.wind?.dir) {
      for (let n = 0; n < B.length; n++) {
        const d = ((B[n] - A[n] + 540) % 360) - 180;
        const v = (A[n] + f * d + 360) % 360;
        out[n] = v === v ? v : f < 0.5 ? A[n] : B[n];
      }
    } else {
      for (let n = 0; n < B.length; n++) {
        const v = A[n] + (B[n] - A[n]) * f;
        out[n] = v === v ? v : f < 0.5 ? A[n] : B[n]; // where only one has data: the nearer one
      }
    }
    data[p] = out;
  }
  const g = { ...a, data, shownTime: time };
  delete g.uid; // a new field for the isosurface worker
  delete g.rangeOf; // and its own range
  return g;
}
// Called every frame: moves the sky on when its time changed; true while it is moving
function advanceSkyClock(now) {
  if (!anim.playing || skyClock.from == null || skyClock.to === skyClock.from) return false;
  if (!(sunGroup.visible || celestialGroup.visible)) return false;
  const t = skyTime();
  if (t === skyClock.shown) return false;
  updateSun({ hud: false }); // the HUD stays calm: it follows the loaded times, the time line the moment
  return true;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function updatePlayButton() {
  $('vcPlay').textContent = anim.playing ? '\u23F8\uFE0E' : '\u25B6\uFE0E'; // text, not emoji, symbols
  $('vcPlay').title = anim.playing ? 'Pause the animation' : 'Animate over time';
  $('vcPlay').classList.toggle('active', anim.playing);
  $('vcStop').disabled = !anim.playing && $('vcTime').value === firstTime(); // already at the start
  updateLoadBlocks();
}

function stopAnimation() {
  if (!anim.playing) return;
  anim.playing = false;
  anim.abort?.abort();
  anim.abort = null;
  skyClock.from = null;
  updateSun(); // back to the shown time
  updatePlayButton();
  $('vcAnimInfo').textContent = '';
  setStatus('Animation paused');
}

async function startAnimation() {
  const times = [...$('datetime').options].map((o) => o.value);
  if (times.length < 2) {
    setStatus('Only one time: nothing to animate', true);
    return;
  }
  state.abort?.abort(); // a load from the panel is replaced by the animation
  // Times touched on the time line wait: the animation's own loading goes first (loads running finish)
  scrubQueue.length = 0;
  scrub.target = null;
  scrub.waiting = false;
  anim.playing = true;
  anim.abort = new AbortController();
  const { signal } = anim.abort;
  updatePlayButton();
  let index = Math.max(0, times.indexOf(state.grid?.datetime ?? $('datetime').value));
  const loop = animationLoop(times, index);
  // The time after i within the loop (k steps on), wrapping to its start; the loop length can change while playing
  const after = (i, k = 1) => {
    loop.n = Math.max(2, Math.min(loopSetting(times.length), times.length - loop.start));
    return loop.start + ((((i - loop.start + k) % loop.n) + loop.n) % loop.n);
  };
  let current = state.grid; // the grid shown for times[index]
  let shownAt = performance.now();
  holdSkyClock(times[index]);
  requestRender();
  try {
    while (anim.playing) {
      const next = after(index);
      const request = buildRequest(times[next]);
      const ready = !!cachedFrame(request.key); // loading shows in the block bar in the view
      const grid = await fetchFrame(request, { signal });
      // Load the next times while this one is shown (Prefetch in the view bar)
      const ahead = Number($('vcPrefetch').value) || 1;
      for (let a = 1; a <= Math.min(ahead, loop.n - 1); a++) {
        fetchFrame(buildRequest(times[after(next, a)]), { signal }).catch(() => {});
      }
      if (!anim.playing) break;
      // The step to the next time starts when that one is there: from when this one was shown if it was in
      // memory already, otherwise now (the sky and the data waited at this time meanwhile)
      const stepStart = ready ? shownAt : performance.now();
      const speed = Number($('vcSpeed').value);
      startSkyClock(times[index], times[next], stepStart);
      const t0 = Date.parse(times[index]), t1 = Date.parse(times[next]);
      const mode = Number($('tweenStep').value); // minutes between in-between frames, -1: continuous, 0: off
      const continuous = mode < 0, tween = continuous ? 0 : mode * 60000;
      const tweening = mode !== 0 && t1 - t0 > tween && sameShape(current, grid);
      if (tweening && canBlendOnGpu() && prepareVolumeBlend(grid)) {
        // On the GPU: only the blend between this time and the next changes, following the sky's clock
        let shown = -1;
        while (anim.playing && performance.now() - stepStart < speed) {
          const f = THREE.MathUtils.clamp((skyTime() - t0) / (t1 - t0), 0, 1);
          const fq = continuous ? f : (Math.floor((f * (t1 - t0)) / tween) * tween) / (t1 - t0);
          if (fq !== shown && fq < 1) {
            shown = fq;
            const time = toIso(Math.round((t0 + fq * (t1 - t0)) / 60000) * 60000); // shown to the minute
            setVolumeBlend(fq, time); // the time line shows the moment; the HUD keeps the loaded time
          }
          await new Promise((res) => requestAnimationFrame(res));
        }
      } else if (tweening) {
        // On the CPU: in between frames at whole multiples of the interval. Continuous with isosurfaces: the next
        // as soon as the isosurface worker has finished the one before (as smooth as it can compute); otherwise
        // every 5 minutes.
        // (only with the worker: small grids are computed here, where every frame would wait for it)
        const surfaces = () => isoGroup.visible && state.isos.some((i) => i.visible) && !!isoWorker && !isoWorkerFailed &&
          grid.nx * grid.ny * grid.nz >= WORKER_MIN_POINTS;
        const step = tween || (surfaces() ? 0 : 5 * 60000);
        let shown = t0;
        while (anim.playing && performance.now() - stepStart < speed) {
          const now = skyTime();
          const t = step ? t0 + Math.floor((now - t0) / step) * step : Math.round(now / 60000) * 60000;
          const busy = surfaces() && state.isos.some((i) => i.visible && i.busy);
          if (t > shown && t < t1 && !busy) {
            shown = t;
            showGrid(interpolateGrid(current, grid, (t - t0) / (t1 - t0), toIso(t)));
          }
          await new Promise((res) => requestAnimationFrame(res));
        }
      } else {
        await sleep(speed - (performance.now() - stepStart));
      }
      if (!anim.playing) break;
      $('datetime').value = times[next];
      shownAt = performance.now();
      holdSkyClock(times[next]);
      showGrid(grid);
      $('vcAnimInfo').textContent = `${next - loop.start + 1}/${loop.n}`;
      setStatus(`Animating: ${times[next]} (${next - loop.start + 1} of ${loop.n}${loop.n < times.length ? `, times ${loop.start + 1}–${loop.start + loop.n} of ${times.length}` : ''}), ${frameCache.size} times in memory (${fmtBytes(frameCacheBytes)})`);
      index = next;
      current = grid;
      await new Promise((res) => requestAnimationFrame(res)); // let the frame be drawn
    }
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
      stopAnimation();
      setStatus(e.message, true);
    }
  }
}

// 1234 → 1234, 45678 → 45.7 k, 1234567 → 1.23 M
const fmtCount = (n) => (n >= 1e6 ? `${(n / 1e6).toPrecision(3)} M` : n >= 1e4 ? `${(n / 1e3).toPrecision(3)} k` : `${n ?? 0}`);

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
    // A native cube URL has its bbox in rotated coordinates; the panel shows lon/lat
    if (p.bbox?.length === 4 && p.crs && state.native?.crs === p.crs) setBBox(bboxToGeo(state.native.proj, p.bbox));
    await loadData();
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  }
}

// ---------------------------------------------------------------- geometry

// The scene positions only change with the grid, levels and vertical coordinate: a new time of the same grid (an
// animation step or an in-between frame) keeps them, unless the heights come from the data (pressure altitude)
let geoKey = null;
function computeGeo() {
  const g = state.grid;
  const { nx, ny, nz, lons, lats } = g;
  const fromData = g.vmode === 'pressure' && !!g.data[g.pressureParam];
  const key = fromData ? null : [viewKey(g), nz, g.vkind, g.levels.join(','), g.proj?.proj4 ?? ''].join('|');
  if (key && key === geoKey && state.geo) return;
  geoKey = key;
  const lon0 = (lons[0] + lons[nx - 1]) / 2, lat0 = (lats[0] + lats[ny - 1]) / 2;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  const px = Float32Array.from(lons, (l) => (l - lon0) * kx);
  const py = Float32Array.from(lats, (l) => (l - lat0) * ky);
  const ext = Math.max(px[nx - 1] - px[0], py[ny - 1] - py[0]);
  const pz = new Float32Array(nx * ny * nz);
  let levelSpacing = 0;
  if (g.vkind === 'pressure' || g.vkind === 'height') {
    // Pressure levels at their ISA height, heights above ground at their height
    for (let k = 0; k < nz; k++) {
      const km = g.vkind === 'pressure' ? isaAltitudeKm(g.levels[k]) : g.levels[k] / 1000;
      pz.fill(km * KM_SCALE, k * nx * ny, (k + 1) * nx * ny);
    }
  } else if (g.vmode === 'pressure' && g.data[g.pressureParam]) {
    const p = g.data[g.pressureParam];
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
  state.geo = { px, py, pz, lon0, lat0, kx, ky, ext, zmin, zmax, levelSpacing, frame: sceneFrame(g, lon0, lat0, kx, ky) };
}

// The scene's axes as Earth-fixed unit vectors, at the centre of the data: x and y along the grid (east and
// north on a lon/lat grid; on a rotated pole grid turned to grid north), z up. Directions such as the sun's
// are turned into the scene with it.
function sceneFrame(g, lon0, lat0, kx, ky) {
  const [lon, lat] = g.proj ? g.proj.toGeo(lon0, lat0) : [lon0, lat0];
  let alpha = 0; // angle of true north from the scene's +y, clockwise
  if (g.proj) {
    const [x2, y2] = g.proj.toRot(lon, Math.min(89.9, lat + 0.05));
    alpha = Math.atan2((x2 - lon0) * kx, (y2 - lat0) * ky);
  }
  const { east, north, up } = enuFrame(lon, lat);
  const ca = Math.cos(alpha), sa = Math.sin(alpha);
  const x = east.map((e, i) => ca * e + sa * north[i]);
  const y = east.map((e, i) => -sa * e + ca * north[i]);
  return { lon, lat, x, y, up };
}

// Sun at the shown time: its direction in the scene (towards the sun), the light, the sky's daylight and the disc
function updateSun({ hud = true } = {}) {
  const time = skyTime();
  skyClock.shown = time;
  updateStars(time);
  const on = $('sunOn').checked && state.grid && state.geo;
  sunGroup.visible = !!on;
  if (!on) {
    moonState.dir = null;
    sunState.dir = null;
    sun.position.copy(DEFAULT_LIGHT);
    sun.intensity = 1.8;
    hemiLight.intensity = 1.4;
    volumeUniforms.lightDir.value.set(-0.4, -0.6, 1.0).normalize();
    skyDomeMaterial.uniforms.daylight.value = 0;
    skyDomeMaterial.uniforms.sunDir.value.set(0, 0, -1);
    starUniforms.fade.value = 1;
    globeEarthUniforms.sunOn.value = 0;
    requestRender();
    updateHud();
    return;
  }
  const { frame } = state.geo;
  const s = sunPosition(time).ecef;
  const dir = new THREE.Vector3(dot(frame.x, s), dot(frame.y, s), dot(frame.up, s)).normalize();
  sunState.dir = dir;
  sunState.elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(dir.z, -1, 1)));
  const enu = enuFrame(frame.lon, frame.lat); // azimuth from true north, also on a rotated grid
  sunState.azimuth = (THREE.MathUtils.radToDeg(Math.atan2(dot(enu.east, s), dot(enu.north, s))) + 360) % 360;
  // Daylight from just below the horizon (twilight) to well above it
  const daylight = THREE.MathUtils.smoothstep(dir.z, -0.1, 0.25);
  sun.position.copy(dir);
  sun.intensity = 0.25 + 1.9 * THREE.MathUtils.smoothstep(dir.z, -0.05, 0.3);
  hemiLight.intensity = 0.7 + 0.7 * daylight;
  volumeUniforms.lightDir.value.copy(dir.z > -0.1 ? dir : DEFAULT_LIGHT).normalize();
  skyDomeMaterial.uniforms.daylight.value = daylight;
  skyDomeMaterial.uniforms.sunDir.value.copy(dir);
  starUniforms.fade.value = 1 - daylight;
  globeEarthUniforms.sunDir.value.copy(dir);
  globeEarthUniforms.sunOn.value = 1;
  const disc = sunGroup.children[0];
  disc.position.copy(dir).multiplyScalar(0.97);
  disc.scale.setScalar(0.11);
  disc.visible = true; // hidden below the horizon by updateSkyObjects
  // The moon, lit from the sun's direction
  const m = moonPosition(time);
  const moonDir = new THREE.Vector3(dot(frame.x, m.ecef), dot(frame.y, m.ecef), dot(frame.up, m.ecef)).normalize();
  moonState.dir = moonDir;
  moonState.elevation = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(moonDir.z, -1, 1)));
  moonState.illuminated = m.illuminated;
  moon.position.copy(moonDir).multiplyScalar(0.95);
  moonMaterial.uniforms.sunDir.value.copy(dir);
  requestRender();
  if (hud) updateHud();
}

// The stars where they are at the shown time: catalogue directions turned with the sidereal time, into the scene
function updateStars(time = skyTime()) {
  if (!state.geo) return;
  const { frame } = state.geo;
  const gmst = sunPosition(time).gmst;
  const pos = celestialGroup.children[0].geometry.attributes.position;
  for (let i = 0; i < STARS.length / 4; i++) {
    const v = skyEcef(STARS[i * 4], STARS[i * 4 + 1], gmst);
    pos.setXYZ(i, dot(frame.x, v) * 0.98, dot(frame.y, v) * 0.98, dot(frame.up, v) * 0.98);
  }
  pos.needsUpdate = true;
  for (const label of starNameLabels) {
    const i = label.userData.star;
    label.position.set(pos.getX(i), pos.getY(i), pos.getZ(i));
  }
  requestRender();
}

// Range of the shown field, kept with the grid: showing a time again does not scan all values again
function dataRange() {
  const g = state.grid, f = g.data[g.param];
  if (g.rangeOf === f) return g.range;
  let lo = Infinity, hi = -Infinity;
  for (let n = 0; n < f.length; n++) {
    const v = f[n];
    if (v < lo) lo = v; // NaN compares false: skipped
    if (v > hi) hi = v;
  }
  g.rangeOf = f;
  g.range = [lo, hi];
  return g.range;
}

// Globe projection (Globe in the view bar): while it is on, every builder places its points through the globe
// mapper, which wraps the flat scene around the Earth (see globe.js). The vertical scale is then part of that
// placement instead of the scale of dataGroup, so changing it rebuilds the geometry. Off: flat, as before.
let globe = null;
function updateGlobeMapper() {
  const want = $('globeOn').checked && state.grid && state.geo;
  // A new time of the same grid keeps the mapper (and the bounds computed with it)
  if (want && globe && globe.geo === state.geo && globe.vscale === vscale() && state.geo.globeBounds) return;
  globe = want ? makeGlobe(state.geo, state.grid.proj, vscale()) : null;
  dataGroup.scale.set(1, 1, globe ? 1 : vscale());
  state.geo && (state.geo.globeBounds = globe ? globeBounds() : null);
}

// A flat scene point (z unscaled) in dataGroup coordinates: on the globe, or as it is
const placePoint = (x, y, z) => (globe ? globe.place(x, y, z) : [x, y, z]);

// Places an array of flat xyz triples in place (globe mode only)
function placeAll(arr) {
  if (!globe) return arr;
  const out = [];
  for (let n = 0; n < arr.length; n += 3) {
    globe.place(arr[n], arr[n + 1], arr[n + 2], out);
    arr[n] = out[0]; arr[n + 1] = out[1]; arr[n + 2] = out[2];
  }
  return arr;
}

// A straight flat segment as `pieces` segments, so it follows the curvature on the globe
function pushSegment(pts, x0, y0, z0, x1, y1, z1, pieces) {
  const n = globe ? pieces : 1;
  for (let i = 0; i < n; i++) {
    const a = i / n, b = (i + 1) / n;
    pts.push(x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, z0 + (z1 - z0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, z0 + (z1 - z0) * b);
  }
}

// Bounding box of the data on the globe (dataGroup = world coordinates there), from points on its outside
function globeBounds() {
  const { px, py, zmin, zmax } = state.geo;
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (let a = 0; a <= 16; a++) {
    for (let b = 0; b <= 16; b++) {
      const x = px[0] + ((px.at(-1) - px[0]) * a) / 16, y = py[0] + ((py.at(-1) - py[0]) * b) / 16;
      for (const z of [zmin, zmax]) box.expandByPoint(v.fromArray(globe.place(x, y, z)));
    }
  }
  return box;
}

// Bounding box of the data in world coordinates, flat or on the globe
function dataBounds(out = new THREE.Box3()) {
  if (state.geo.globeBounds) return out.copy(state.geo.globeBounds);
  const { px, py, zmin, zmax } = state.geo;
  const s = vscale();
  out.min.set(px[0], py[0], zmin * s);
  out.max.set(px.at(-1), py.at(-1), zmax * s);
  return out;
}

// The Earth's axis on the globe: a line through both poles, reaching beyond them, with N and S at its ends (the
// Earth hides the part inside it)
const axisGroup = new THREE.Group();
dataGroup.add(axisGroup);
let axisBuiltFor = null;
function buildEarthAxis() {
  if (axisBuiltFor === globe && (axisGroup.children.length > 0) === !!globe) return;
  axisBuiltFor = globe;
  disposeChildren(axisGroup);
  if (!globe) return;
  const out = 0.35 * EARTH_RADIUS; // beyond the surface
  const n = globe.placeLonLat(0, 90, out), s = globe.placeLonLat(0, -90, out);
  const geom = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([...s, ...n], 3));
  axisGroup.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xb8c8da, transparent: true, opacity: 0.55, fog: false })));
  for (const [text, lat] of [['N', 90], ['S', -90]]) {
    const label = makeLabel(text, EARTH_RADIUS * 0.06);
    label.position.fromArray(globe.placeLonLat(0, lat, out * 1.12));
    axisGroup.add(label);
  }
}

function rebuildAll() {
  computeGeo();
  updateGlobeMapper();
  buildEarthAxis();
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
  buildGridCells();
  // Borders, the map under the data and the earth around it do not change with the time: an animation step or a
  // new time of the same area keeps them (rebuilding the borders alone takes a noticeable fraction of a second)
  const { lon0, lat0, kx, ky, zmin, ext } = state.geo;
  const staticKey = JSON.stringify([lon0, lat0, kx, ky, zmin, ext, g.lons[0], g.lons.at(-1), g.lats[0], g.lats.at(-1), g.nx, g.ny,
    g.crs, globe ? globe.vscale : 0, !!state.borders, $('baseLayer').value, groundLayer(), $('earthOn').checked]);
  if (staticKey !== state.staticKey) {
    state.staticKey = staticKey;
    buildBorders();
    buildGround();
    buildEarth();
  }
  buildSlices();
  for (const iso of state.isos) buildIso(iso);
  buildVolume();
  buildStreamlines();
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
  state.volume.tex2?.dispose();
  volumeUniforms.vol2.value = null;
  state.volume = null;
}

// In-between frames on the GPU: the next time goes into a second texture once per step, and every in-between
// frame only changes the blend between the two. Only while the volume is the only thing showing the values
// (isosurfaces, slices and streamlines need them on the CPU); returns false when it cannot be used.
function canBlendOnGpu() {
  return !!state.volume && $('renderMode').value === 'volume' && !sliceGroup.children.length && !streamlines.object.visible;
}

function prepareVolumeBlend(next) {
  const v = state.volume, g = state.grid;
  if (!v || !sameShape(g, next) || v.geo !== state.geo) return false;
  const { pz, zmin, zmax } = state.geo;
  const placedByHeight = next.vkind === 'pressure' || next.vkind === 'height' || (next.vmode === 'pressure' && !!next.data[next.pressureParam]);
  if (placedByHeight && next.vmode === 'pressure') return false; // heights from the data differ per time
  const vol = resampleVolume(next.data[next.param], next.nx, next.ny, next.nz, pz, zmin, zmax, !placedByHeight, v.tex2?.image.data);
  if (vol.depth !== v.tex.image.depth) return false;
  if (v.tex2 && vol.data === v.tex2.image.data) v.tex2.needsUpdate = true;
  else {
    v.tex2?.dispose();
    v.tex2 = createVolumeTexture(vol, next.nx, next.ny);
  }
  v.nextGrid = next;
  volumeUniforms.vol2.value = v.tex2;
  return true;
}

function setVolumeBlend(f, time) {
  volumeUniforms.blend.value = f;
  gpuTween = f > 0 ? { grid: state.grid, time } : null;
  requestRender();
}

function resetVolumeBlend() {
  volumeUniforms.blend.value = 0;
  gpuTween = null;
}

function buildVolume() {
  const g = state.grid;
  const placement = `${g?.nx}x${g?.ny}x${g?.nz}:${globe ? globe.vscale : 'flat'}`;
  // A new time of the same grid in the same place (same scene positions): only the values change, written into
  // the texture there is, without a new texture, mesh or shader set-up
  resetVolumeBlend();
  if (state.volume && g && state.volume.geo === state.geo && state.volume.placement === placement && $('renderMode').value !== 'iso') {
    // The next time was already put on the graphics card for the in-between frames: the textures swap roles
    if (state.volume.nextGrid === g && state.volume.tex2) {
      [state.volume.tex, state.volume.tex2] = [state.volume.tex2, state.volume.tex];
      state.volume.nextGrid = null;
      volumeUniforms.vol.value = state.volume.tex;
      volumeUniforms.vol2.value = state.volume.tex2;
      return;
    }
    state.volume.nextGrid = null;
    const { pz, zmin, zmax } = state.geo, tex = state.volume.tex;
    const placedByHeight = g.vkind === 'pressure' || g.vkind === 'height' || (g.vmode === 'pressure' && !!g.data[g.pressureParam]);
    const vol = resampleVolume(g.data[g.param], g.nx, g.ny, g.nz, pz, zmin, zmax, !placedByHeight, tex.image.data);
    if (vol.data === tex.image.data) {
      tex.needsUpdate = true;
      return;
    }
  }
  disposeVolume();
  if (!g || g.nz < 2 || $('renderMode').value === 'iso') return;
  const { px, py, pz, zmin, zmax } = state.geo;
  // Evenly spaced model levels go into the texture as they are; anything placed at real heights is resampled
  const placedByHeight = g.vkind === 'pressure' || g.vkind === 'height' || (g.vmode === 'pressure' && !!g.data[g.pressureParam]);
  const vol = resampleVolume(g.data[g.param], g.nx, g.ny, g.nz, pz, zmin, zmax, !placedByHeight);
  const tex = createVolumeTexture(vol, g.nx, g.ny);
  volumeUniforms.vol.value = tex;
  volumeUniforms.texSize.value.set(g.nx, g.ny, vol.depth);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), volumeMaterial);
  const wantGlobe = !!globe;
  if (('GLOBE' in volumeMaterial.defines) !== wantGlobe) { // (the define's value is '', so not its truth)
    if (wantGlobe) volumeMaterial.defines.GLOBE = ''; else delete volumeMaterial.defines.GLOBE;
    volumeMaterial.needsUpdate = true;
  }
  if (globe) {
    // The box is the bounding box of the curved data; the shader turns every sample back to the flat texture
    const b = state.geo.globeBounds, size = b.getSize(new THREE.Vector3());
    mesh.scale.copy(size);
    b.getCenter(mesh.position);
    const u = volumeUniforms, { frame, lon0, lat0, kx, ky } = state.geo;
    u.gBoxMin.value.copy(b.min);
    u.gBoxSize.value.copy(size);
    u.gFx.value.fromArray(frame.x); u.gFy.value.fromArray(frame.y); u.gUp.value.fromArray(frame.up);
    u.gR.value = EARTH_RADIUS;
    u.gVscale.value = globe.vscale;
    u.gGrid0.value.set(lon0, lat0);
    u.gK.value.set(kx, ky);
    u.gFlat0.value.set(px[0], py[0], zmin);
    u.gFlatSize.value.set(px.at(-1) - px[0], py.at(-1) - py[0], zmax - zmin);
    u.gRotated.value = g.proj ? 1 : 0;
    if (g.proj) u.gPole.value.set(g.proj.lon0, g.proj.oLatP);
  } else {
    mesh.scale.set(px.at(-1) - px[0], py.at(-1) - py[0], zmax - zmin);
    mesh.position.set((px[0] + px.at(-1)) / 2, (py[0] + py.at(-1)) / 2, (zmin + zmax) / 2);
  }
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  volumeGroup.add(mesh);
  state.volume = { mesh, tex, geo: state.geo, placement };
}

function applyRenderMode() {
  const mode = $('renderMode').value;
  isoGroup.visible = mode !== 'volume';
  volumeGroup.visible = mode !== 'iso';
  $('volumeOpts').hidden = mode === 'iso';
  if (volumeGroup.visible && !state.volume) buildVolume();
  if (isoGroup.visible) for (const iso of state.isos) if (iso.dirty) buildIso(iso);
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

// Streamlines for the derived wind: the wind vector per grid point from speed and direction (where the wind
// comes from, degrees clockwise from true north), turned to the scene. On a rotated pole grid north differs per
// point, so the angle between true north and grid north is taken at every column. Particles start where the
// volume is drawn: in 'fill above' only above the threshold, so they trace e.g. the jet stream.
const STREAM_CROSS_TIME = 12; // seconds for the fastest wind to cross the area
let streamWind = null; // { grid, u, v } of the last computed wind, reused when only the threshold changes

function buildStreamlines() {
  const g = state.grid;
  streamlines.object.visible = !!g?.wind && $('vcStream').checked;
  if (!g?.wind || !streamlines.object.visible) return;
  const { nx, ny, nz, lons, lats, proj } = g;
  const { px, py, pz, kx, ky } = state.geo;
  if (streamWind?.grid !== g) {
    const speed = g.data[g.wind.speed], dir = g.data[g.wind.dir];
    // Angle of true north in the scene per column (0 on a lon/lat grid, where north is +y everywhere)
    const north = new Float32Array(nx * ny);
    if (proj) {
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const [lon, lat] = proj.toGeo(lons[i], lats[j]);
        const [x2, y2] = proj.toRot(lon, Math.min(89.9, lat + 0.05));
        north[j * nx + i] = Math.atan2((x2 - lons[i]) * kx, (y2 - lats[j]) * ky);
      }
    }
    const u = new Float32Array(nx * ny * nz), v = new Float32Array(nx * ny * nz);
    for (let n = 0; n < u.length; n++) {
      const s = speed[n], d = dir[n] * DEG;
      if (s !== s || d !== d) { u[n] = v[n] = NaN; continue; }
      const east = -s * Math.sin(d), northward = -s * Math.cos(d); // towards which the wind blows
      const a = north[n % (nx * ny)], ca = Math.cos(a), sa = Math.sin(a);
      u[n] = east * ca + northward * sa;
      v[n] = -east * sa + northward * ca;
    }
    streamWind = { grid: g, u, v };
  }
  const speed = g.data[g.param];
  const vis = state.isos.filter((iso) => iso.visible);
  const t = vis[0]?.value, style = Number($('volStyle').value), width = Number($('volWidth').value);
  const volumeShown = $('renderMode').value !== 'iso' && t != null;
  const seedable = (n) => {
    const s = speed[n];
    if (s !== s) return false;
    if (!volumeShown) return true;
    if (style === 0) return s >= t;
    if (style === 1) return s <= t;
    return vis.slice(0, MAX_ISO_LINES).some((iso) => Math.abs(s - iso.value) <= 1.5 * width);
  };
  streamlines.setField({
    nx, ny, nz, u: streamWind.u, v: streamWind.v, speed, px, py, pz, seedable, crossTime: STREAM_CROSS_TIME,
    place: globe ? (x, y, z) => globe.place(x, y, z) : null, // on the globe the trails are placed there
  });
}
const DEG = Math.PI / 180;

// The grid cells in use (after averaging, on the native grid when loaded so): cell edges on the ground, and on
// the west and north walls a line per column and per loaded level. In pressure-altitude mode the level lines
// follow the actual heights along the wall.
function buildGridCells() {
  disposeChildren(gridGroup);
  gridGroup.visible = $('gridOn').checked;
  if (!state.grid || !gridGroup.visible) return;
  const { nx, ny, nz } = state.grid;
  const { px, py, pz, zmin, zmax, ext } = state.geo;
  // Cell edges halfway between the centres; the outer cells end at the box, which runs from centre to centre
  const edges = (c) => [c[0], ...Array.from({ length: c.length - 1 }, (_, n) => (c[n] + c[n + 1]) / 2), c.at(-1)];
  const ex = edges(px), ey = edges(py);
  const x0 = px[0], x1 = px.at(-1), y0 = py[0], y1 = py.at(-1);
  const zg = zmin - layerSize() * 0.0022; // just above the base map, below the borders
  const pts = [];
  for (const x of ex) pushSegment(pts, x, y0, zg, x, y1, zg, ny);
  for (const y of ey) pushSegment(pts, x0, y, zg, x1, y, zg, nx);
  // Walls: west (x = x0) and north (y = y1), where the level labels are
  for (const x of ex) pts.push(x, y1, zmin, x, y1, zmax);
  for (const y of ey) pts.push(x0, y, zmin, x0, y, zmax);
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = (k * ny + ny - 1) * nx + i;
      pts.push(px[i], y1, pz[a], px[i + 1], y1, pz[a + 1]);
    }
    for (let j = 0; j < ny - 1; j++) {
      const a = (k * ny + j) * nx;
      pts.push(x0, py[j], pz[a], x0, py[j + 1], pz[a + nx]);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(placeAll(pts), 3));
  const mat = new THREE.LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.18, depthWrite: false });
  gridGroup.add(new THREE.LineSegments(geom, mat));
}

const boxBuilt = { geo: null, globe: null };
function buildBox() {
  // Only the layout and the globe mapper shape the box: a new time of the same grid keeps it
  if (boxBuilt.geo === state.geo && boxBuilt.globe === globe && boxGroup.children.length) {
    boxGroup.visible = $('boxOn').checked;
    return;
  }
  Object.assign(boxBuilt, { geo: state.geo, globe });
  disposeChildren(boxGroup);
  const { px, py, zmin, zmax } = state.geo;
  // Data all around the Earth on the globe: a box has no meaning there (its edges would loop at the poles)
  if (globe && state.grid.lons.at(-1) - state.grid.lons[0] > 300) return;
  if (globe) {
    // The 12 edges, curved along the globe
    const x = [px[0], px.at(-1)], y = [py[0], py.at(-1)], z = [zmin, zmax], pts = [];
    for (const zz of z) {
      for (const yy of y) pushSegment(pts, x[0], yy, zz, x[1], yy, zz, 64);
      for (const xx of x) pushSegment(pts, xx, y[0], zz, xx, y[1], zz, 64);
    }
    for (const xx of x) for (const yy of y) pushSegment(pts, xx, yy, z[0], xx, yy, z[1], 1);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(placeAll(pts), 3));
    boxGroup.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x4a5868 })));
  } else {
    const box = new THREE.Box3(new THREE.Vector3(px[0], py[0], zmin), new THREE.Vector3(px.at(-1), py.at(-1), zmax));
    boxGroup.add(new THREE.Box3Helper(box, 0x4a5868));
  }
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

// Border lines in the grid's x/y: lon/lat, or rotated lon/lat for a native rotated pole grid (cached).
let bordersInGrid = { proj: null, lines: null };
function gridBorders(proj) {
  if (!proj) return state.borders;
  if (bordersInGrid.proj !== proj || bordersInGrid.src !== state.borders) {
    bordersInGrid = { proj, src: state.borders, lines: state.borders.map((line) => line.map(([lon, lat]) => proj.toRot(lon, lat))) };
  }
  return bordersInGrid.lines;
}

function buildBorders() {
  disposeChildren(mapGroup);
  if (!state.grid) return;
  const { lons, lats, proj } = state.grid;
  const { lon0, lat0, kx, ky, zmin, px, py, ext } = state.geo;
  const z = zmin - layerSize() * 0.002;
  if (state.borders) {
    const rect = [lons[0], lats[0], lons.at(-1), lats.at(-1)];
    const pts = [];
    for (const line of gridBorders(proj)) {
      for (let n = 1; n < line.length; n++) {
        if (Math.abs(line[n][0] - line[n - 1][0]) > 180) continue; // wraps around the (rotated) date line
        const s = clipSegment(line[n - 1][0], line[n - 1][1], line[n][0], line[n][1], rect);
        if (s) pts.push((s[0] - lon0) * kx, (s[1] - lat0) * ky, z, (s[2] - lon0) * kx, (s[3] - lat0) * ky, z);
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(placeAll(pts), 3));
    mapGroup.add(new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0xc8d3de })));
  }
  mapGroup.visible = $('bordersOn').checked;
}

// ---------------------------------------------------------------- WMS base map

// Vector base map (Base map → Land and sea): drawn in a worker (vectorworker.js), which fetches the Natural Earth
// file itself; on the main thread only without one, once the file of the borders is there
const vectorWorker = (() => {
  try {
    if (typeof OffscreenCanvas === 'undefined') return null;
    return new Worker(new URL('./vectorworker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
})();
const vectorJobs = new Map();
let vectorJobId = 0;
vectorWorker?.addEventListener('message', ({ data }) => {
  const job = vectorJobs.get(data.id);
  vectorJobs.delete(data.id);
  if (data.error) job?.reject(new Error(data.error));
  else job?.resolve(data.bitmap);
});
vectorWorker?.addEventListener('error', (e) => {
  for (const job of vectorJobs.values()) job.reject(new Error(e.message || 'worker failed'));
  vectorJobs.clear();
});
function drawVectorBitmap(bbox, proj, width, height) {
  if (!vectorWorker) return Promise.reject(new Error('no worker'));
  const id = ++vectorJobId;
  return new Promise((resolve, reject) => {
    vectorJobs.set(id, { resolve, reject });
    vectorWorker.postMessage({ id, url: BORDERS_URL, bbox, pole: proj ? { lon0: proj.lon0, oLatP: proj.oLatP } : null, width, height });
  });
}
let resolveVectorData;
const vectorData = new Promise((res) => (resolveVectorData = res));

// The vector map of an area in grid coordinates ([x0, y0, x1, y1]: lon/lat, or rotated lon/lat with proj), as a
// texture cached per slot like the WMS images; size: the width in pixels (the height follows the area)
function vectorMapTexture(slot, bbox, proj, size) {
  const [x0, y0, x1, y1] = bbox;
  const width = size, height = Math.max(64, Math.min(size, Math.round((size * (y1 - y0)) / Math.max(x1 - x0, 1e-9))));
  const key = `${VECTOR_LAYER}|${bbox.map((v) => v.toFixed(4)).join(',')}|${proj?.proj4 ?? ''}|${width}x${height}`;
  const current = state.mapTex[slot];
  if (current?.url === key) return current.promise;
  current?.tex?.dispose();
  const entry = { url: key, tex: null };
  entry.promise = drawVectorBitmap(bbox, proj, width, height)
    .catch((e) => {
      // Without the worker (or OffscreenCanvas): drawn here, which holds up the view for a moment
      console.warn('Vector base map drawn on the main thread:', e.message);
      return vectorData.then(() => {
        state.land ??= landPolygons(topojson, state.worldTopo);
        return drawVectorMap({ land: state.land, borders: state.borders, width, height, ...gridProjection(bbox, proj, width, height) });
      });
    })
    .then((image) => {
      const bitmap = typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
      const tex = bitmap ? new THREE.Texture(image) : new THREE.CanvasTexture(image);
      if (bitmap) tex.flipY = false; // the worker flipped it already (WebGL does not flip bitmaps)
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
      tex.needsUpdate = true;
      entry.tex = tex;
      return tex;
    })
    .catch((e) => {
      console.warn('Vector base map could not be drawn', e);
      if (state.mapTex[slot] === entry) delete state.mapTex[slot];
      return null;
    });
  state.mapTex[slot] = entry;
  return entry.promise;
}

// One cached texture per slot, so the map under the data and the earth surface do not replace each other
function getMapTexture(url, slot = 'ground') {
  const current = state.mapTex[slot];
  if (current?.url === url) return current.promise;
  current?.tex?.dispose();
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
      if (state.mapTex[slot] === entry) delete state.mapTex[slot];
      return null;
    });
  state.mapTex[slot] = entry;
  return entry.promise;
}

// Ground plane under the cube, textured with a WMS GetMap image in the grid's CRS: CRS:84 (plain
// lon/lat) or the rotated pole projection of a native grid, so the image maps linearly onto x/y.
function buildGround() {
  disposeChildren(groundGroup);
  if (!state.grid) return;
  const { lons, lats, proj } = state.grid;
  const { px, py, zmin, ext } = state.geo;
  const w = px.at(-1) - px[0], h = py.at(-1) - py[0];
  const mat = new THREE.MeshBasicMaterial({
    color: 0x18212b, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
  });
  const cx = (px[0] + px.at(-1)) / 2, cy = (py[0] + py.at(-1)) / 2, zg = zmin - layerSize() * 0.003;
  if (globe) addNightShading(mat); // shaded like the Earth around it
  const plane = globe ? new THREE.PlaneGeometry(w, h, 96, 96) : new THREE.PlaneGeometry(w, h);
  if (globe) {
    // Each vertex to its place on the globe (the plane's own coordinates are relative to the centre of the data)
    const pos = plane.attributes.position, out = [];
    for (let n = 0; n < pos.count; n++) {
      globe.place(cx + pos.getX(n), cy + pos.getY(n), zg, out);
      pos.setXYZ(n, out[0], out[1], out[2]);
    }
    plane.computeBoundingSphere();
  }
  const ground = new THREE.Mesh(plane, mat);
  if (!globe) ground.position.set(cx, cy, zg);
  groundGroup.add(ground);

  const layer = groundLayer();
  if (!layer) return;
  const iw = 1536, ih = Math.min(2048, Math.round((iw * h) / w));
  const url = `${WMS_URL}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&CRS=${proj ? encodeURIComponent(`PROJ4:${proj.proj4}`) : 'CRS:84'}&BBOX=${lons[0]},${lats[0]},${lons.at(-1)},${lats.at(-1)}` +
    `&WIDTH=${iw}&HEIGHT=${ih}&FORMAT=image/png&TRANSPARENT=FALSE`;
  const texture = layer === VECTOR_LAYER
    ? vectorMapTexture('ground', [lons[0], lats[0], lons.at(-1), lats.at(-1)], proj, 2048)
    : getMapTexture(url);
  texture.then((tex) => {
    if (!tex || ground.parent !== groundGroup) return;
    mat.map = tex;
    mat.color.setScalar(Number($('mapBrightness').value));
    mat.needsUpdate = true;
    requestRender();
  });
}

// Earth surface around the data: the base map continued over about seven times the data area, with faint
// degree lines, a little below the map under the data, and darker than it. A reference for height and motion
// when flying low. In the grid's coordinates, like the map under the data.
const EARTH_SIZE = 7; // times the width and height of the data area
const EARTH_BRIGHTNESS = 0.12; // times the map brightness (in linear colour, so this is about 40% as bright as seen): darker than the data area

function buildEarth() {
  disposeChildren(earthGroup);
  earthGroup.visible = $('earthOn').checked;
  if (!state.grid || !earthGroup.visible) return;
  if (globe) {
    buildGlobeEarth();
    return;
  }
  const { lons, lats, proj } = state.grid;
  const { lon0, lat0, kx, ky, zmin, ext } = state.geo;
  const half = (EARTH_SIZE - 1) / 2;
  const dLon = lons.at(-1) - lons[0], dLat = lats.at(-1) - lats[0];
  // Around the data area, limited to the coordinate range of the CRS
  const bbox = [
    Math.max(-180, lons[0] - half * dLon), Math.max(-90, lats[0] - half * dLat),
    Math.min(180, lons.at(-1) + half * dLon), Math.min(90, lats.at(-1) + half * dLat),
  ];
  const sx = (v) => (v - lon0) * kx, sy = (v) => (v - lat0) * ky;
  const w = sx(bbox[2]) - sx(bbox[0]), h = sy(bbox[3]) - sy(bbox[1]);
  const z = zmin - ext * 0.006; // below the map under the data, so that one stays on top

  // Not in the depth haze: the haze colour would lighten it again
  const mat = new THREE.MeshBasicMaterial({ color: 0x10161c, fog: false, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 });
  const earth = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  earth.position.set((sx(bbox[0]) + sx(bbox[2])) / 2, (sy(bbox[1]) + sy(bbox[3])) / 2, z);
  earthGroup.add(earth);

  // Degree lines: a reference for motion also without a base map
  const step = niceStep(Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]), 24);
  const pts = [];
  for (let v = Math.ceil(bbox[0] / step) * step; v <= bbox[2]; v += step) pts.push(sx(v), sy(bbox[1]), z, sx(v), sy(bbox[3]), z);
  for (let v = Math.ceil(bbox[1] / step) * step; v <= bbox[3]; v += step) pts.push(sx(bbox[0]), sy(v), z, sx(bbox[2]), sy(v), z);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: 0x8fa3b8, transparent: true, opacity: 0.12, depthWrite: false, fog: false }));
  earthGroup.add(lines);

  const layer = $('baseLayer').value;
  if (!layer) return;
  const iw = 2048, ih = Math.max(64, Math.min(2048, Math.round((iw * h) / w)));
  const url = `${WMS_URL}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&CRS=${proj ? encodeURIComponent(`PROJ4:${proj.proj4}`) : 'CRS:84'}&BBOX=${bbox.join(',')}` +
    `&WIDTH=${iw}&HEIGHT=${ih}&FORMAT=image/png&TRANSPARENT=FALSE`;
  const texture = layer === VECTOR_LAYER ? vectorMapTexture('earth', bbox, proj, 2048) : getMapTexture(url, 'earth');
  texture.then((tex) => {
    if (!tex || earth.parent !== earthGroup) return;
    mat.map = tex;
    mat.color.setScalar(Number($('mapBrightness').value) * EARTH_BRIGHTNESS);
    mat.needsUpdate = true;
    requestRender();
  });
}

// The whole Earth in globe mode: a lon/lat grid on the sphere, just below the map under the data, with the
// base map of the whole world (CRS:84) and faint degree lines. With the sun on, the night side is darker.
const globeEarthUniforms = { sunDir: { value: new THREE.Vector3(0, 0, 1) }, sunOn: { value: 0 } };
const GLOBE_LAYER = 'countryfilled'; // a base layer of the whole world
// On the globe, the night side darker when the sun is on: the light from the direction of the sun on the radial
// normal (for the Earth around the data and the map under it)
function addNightShading(mat) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.sunDir = globeEarthUniforms.sunDir;
    shader.uniforms.sunOn = globeEarthUniforms.sunOn;
    shader.uniforms.globeCentre = { value: new THREE.Vector3(...globe.centre) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 globeCentre;\nvarying vec3 vRadial;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRadial = position - globeCentre;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 sunDir;\nuniform float sunOn;\nvarying vec3 vRadial;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        if (sunOn > 0.5) diffuseColor.rgb *= mix(0.25, 1.0, smoothstep(-0.08, 0.12, dot(normalize(vRadial), normalize(sunDir))));`);
  };
  mat.customProgramCacheKey = () => 'globe-night';
}

// The size the small height offsets between the layers on the ground (earth, map, borders, grid) scale with: on
// the globe at most that of a 6000 km area, as data covering the whole Earth would push them hundreds of km apart
const layerSize = () => (globe ? Math.min(state.geo.ext, 6000) : state.geo.ext);

function buildGlobeEarth() {
  const { zmin, ext } = state.geo;
  const h = (zmin - layerSize() * 0.006) * globe.vscale; // below the map under the data
  const NLON = 256, NLAT = 128;
  const pos = new Float32Array((NLON + 1) * (NLAT + 1) * 3), uv = new Float32Array((NLON + 1) * (NLAT + 1) * 2), out = [];
  for (let j = 0; j <= NLAT; j++) {
    for (let i = 0; i <= NLON; i++) {
      const lon = -180 + (360 * i) / NLON, lat = -90 + (180 * j) / NLAT, n = j * (NLON + 1) + i;
      globe.placeLonLat(lon, lat, h, out);
      pos.set(out, n * 3);
      uv.set([i / NLON, j / NLAT], n * 2);
    }
  }
  const index = [];
  for (let j = 0; j < NLAT; j++) {
    for (let i = 0; i < NLON; i++) {
      const a = j * (NLON + 1) + i, b = a + 1, c = a + NLON + 1, d = c + 1;
      index.push(a, b, d, a, d, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex(index);
  const mat = new THREE.MeshBasicMaterial({ color: 0x10161c, fog: false, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 4 });
  addNightShading(mat);
  const earth = new THREE.Mesh(geom, mat);
  earth.frustumCulled = false;
  earthGroup.add(earth);

  // Degree lines every 15°, just above the map under the data (which can cover the whole Earth)
  const hl = (state.geo.zmin - layerSize() * 0.0025) * globe.vscale;
  const pts = [];
  for (let lon = -180; lon < 180; lon += 15) for (let lat = -90; lat < 90; lat += 2) pts.push(...globe.placeLonLat(lon, lat, hl), ...globe.placeLonLat(lon, lat + 2, hl));
  for (let lat = -75; lat <= 75; lat += 15) for (let lon = -180; lon < 180; lon += 2) pts.push(...globe.placeLonLat(lon, lat, hl), ...globe.placeLonLat(lon + 2, lat, hl));
  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  earthGroup.add(new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0x8fa3b8, transparent: true, opacity: 0.22, depthWrite: false, fog: false })));

  // The selected base layer may cover only Europe (empty elsewhere): the globe uses a world layer, and the map
  // under the data keeps the selected one
  if (!$('baseLayer').value) return;
  const vector = $('baseLayer').value === VECTOR_LAYER; // the same vector map around the data, a little darker
  const url = `${WMS_URL}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${GLOBE_LAYER}&STYLES=` +
    '&CRS=CRS:84&BBOX=-180,-90,180,90&WIDTH=4096&HEIGHT=2048&FORMAT=image/png&TRANSPARENT=FALSE';
  (vector ? vectorMapTexture('globe', [-180, -90, 180, 90], null, 4096) : getMapTexture(url, 'globe')).then((tex) => {
    if (!tex || earth.parent !== earthGroup) return;
    mat.map = tex;
    mat.color.setScalar(Number($('mapBrightness').value) * (vector ? 0.7 : 0.35)); // darker than the data area, which stays on top
    mat.needsUpdate = true;
    requestRender();
  });
}

// Extent (lon/lat) of each base layer, from the capabilities: a layer that does not cover the data (e.g. a Europe
// map for global data) is replaced by the world layer under the data
const baseLayerExtent = new Map();
const BASE_LAYER_DEFAULT_EXTENT = [-38.17, 29.93, 72.01, 72.69]; // the default Europe layer, until the capabilities are read

// The lon/lat range of the data (on a rotated grid: of its edges)
function dataLonLatBounds() {
  const { lons, lats, proj } = state.grid;
  if (!proj) return [lons[0], lats[0], lons.at(-1), lats.at(-1)];
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k <= 16; k++) {
    const x = lons[0] + ((lons.at(-1) - lons[0]) * k) / 16, y = lats[0] + ((lats.at(-1) - lats[0]) * k) / 16;
    for (const [gx, gy] of [[x, lats[0]], [x, lats.at(-1)], [lons[0], y], [lons.at(-1), y]]) {
      const [lon, lat] = proj.toGeo(gx, gy);
      b[0] = Math.min(b[0], lon); b[1] = Math.min(b[1], lat); b[2] = Math.max(b[2], lon); b[3] = Math.max(b[3], lat);
    }
  }
  return b;
}

// The base layer for the map under the data: the selected one, or the world layer when that does not cover it
function groundLayer() {
  const layer = $('baseLayer').value;
  if (!layer || layer === GLOBE_LAYER) return layer;
  const ext = baseLayerExtent.get(layer) ?? (layer === 'knmi_animated_gif_background_europe_elevation_1km_combined' ? BASE_LAYER_DEFAULT_EXTENT : null);
  if (!ext) return layer;
  // Kept when it covers most of the data (a little beyond its edge just shows the background colour)
  const [w, s, e, n] = dataLonLatBounds();
  const overlap = Math.max(0, Math.min(e, ext[2]) - Math.max(w, ext[0])) * Math.max(0, Math.min(n, ext[3]) - Math.max(s, ext[1]));
  return overlap >= 0.6 * Math.max((e - w) * (n - s), 1e-6) ? layer : GLOBE_LAYER;
}

async function loadBaseLayers() {
  const sel = $('baseLayer');
  let layers = [];
  try {
    const r = await fetch(`${WMS_URL}SERVICE=WMS&REQUEST=GetCapabilities`);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/xml');
    const child = (el, tag) => [...el.children].find((c) => c.localName === tag)?.textContent;
    layers = [...doc.getElementsByTagNameNS('*', 'Layer')]
      .map((l) => {
        const g = [...l.children].find((c) => c.localName === 'EX_GeographicBoundingBox');
        const ext = g && ['westBoundLongitude', 'southBoundLatitude', 'eastBoundLongitude', 'northBoundLatitude'].map((k) => Number(child(g, k)));
        return { name: child(l, 'Name'), title: child(l, 'Title'), ext: ext?.every(Number.isFinite) ? ext : null };
      })
      .filter((l) => l.name);
    for (const l of layers) if (l.ext) baseLayerExtent.set(l.name, l.ext);
  } catch (e) {
    console.warn('Could not read baselayers capabilities', e);
    return;
  }
  const current = sel.value;
  sel.innerHTML = '';
  sel.append(option('', 'None'));
  sel.append(option(VECTOR_LAYER, 'Land and sea (vector, Natural Earth)'));
  for (const l of layers) sel.append(option(l.name, l.title && l.title !== l.name ? l.title : l.name));
  sel.value = current === VECTOR_LAYER || layers.some((l) => l.name === current) ? current : '';
  if (state.grid) buildGround(); // now the layer's extent is known (see groundLayer)
}

async function loadBorders() {
  try {
    const topo = await fetchJSON(BORDERS_URL, { retries: 1 });
    state.borders = topojson.mesh(topo, topo.objects.countries).coordinates;
    state.worldTopo = topo; // for the vector base map, when it has to be drawn on the main thread
    resolveVectorData();
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
      pos.set(placePoint(px[i], py[j], pz[p]), n * 3);
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

// Axis text for an x or y value: °E/°N, or rotated degrees on a native rotated pole grid.
const axisText = (v, axis, digits = 2) => {
  const n = typeof v === 'number' ? fmt(v, digits) : v;
  return state.grid?.proj ? `${n}° r${axis === 'x' ? 'lon' : 'lat'}` : `${n}°${axis === 'x' ? 'E' : 'N'}`;
};

function buildSlices() {
  disposeChildren(sliceGroup);
  const g = state.grid;
  if (!g) return;
  const { nx, ny, nz, levels, lons, lats } = g;
  const kz = nz - 1 - Number($('sliceZ').value), ix = Number($('sliceX').value), jy = Number($('sliceY').value);
  $('sliceZOut').textContent = `lvl ${levels[kz]}`;
  $('sliceXOut').textContent = axisText(lons[ix], 'x');
  $('sliceYOut').textContent = axisText(lats[jy], 'y');
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

// Isosurfaces of large grids are computed in a worker, so sliders stay smooth; small grids directly, which
// is faster than copying the field. Only the newest value is computed: while the worker is busy, a newer
// value waits and replaces older waiting ones. The previous surface stays until the new one arrives. While
// only the volume is shown the surface is not computed at all; it is built when the isosurface is shown.
const WORKER_MIN_POINTS = 500000;
const isoWorker = (() => {
  try {
    return new Worker(new URL('./isoworker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    console.warn('No isosurface worker, computing on the main thread', e);
    return null;
  }
})();
let isoRequest = 0, gridUid = 0, workerFieldKey = null, isoWorkerFailed = false;
const isoRequests = new Map(); // request id → iso

// Identifies the field and heights the worker has: the grid, the parameter and the vertical coordinate
const isoFieldKey = (g) => `${(g.uid ??= ++gridUid)}:${g.param}:${g.vmode}:${state.geo.zmax}`;

function sendFieldToWorker(g, key) {
  if (workerFieldKey === key) return;
  const { px, py, pz } = state.geo;
  isoWorker.postMessage({ type: 'field', key, field: g.data[g.param], nx: g.nx, ny: g.ny, nz: g.nz, px, py, pz }); // copied
  workerFieldKey = key;
}

isoWorker?.addEventListener('message', ({ data }) => {
  const iso = isoRequests.get(data.id);
  isoRequests.delete(data.id);
  if (!iso) return;
  iso.busy = false;
  const g = state.grid;
  const current = g && state.isos.includes(iso) && iso.visible && !iso.dirty && isoGroup.visible;
  if (!current) return;
  if (data.error) {
    // Not again in the worker (that would repeat the error): compute this one on the main thread
    console.warn('Isosurface worker failed, computing on the main thread:', data.error);
    computeIsoHere(iso);
    return;
  }
  // Also a surface of the previous time of the same grid (an in-between frame while animating): shown, as the
  // newest one would otherwise never arrive while the frames keep coming; then the newest is computed
  const layout = (key) => key.slice(key.indexOf(':'));
  if (data.key === isoFieldKey(g) || layout(data.key) === layout(isoFieldKey(g))) showIsoResult(iso, data, data.ms);
  // A newer value (or another grid) was asked for meanwhile: compute that one now
  if (iso.wanted !== data.value || data.key !== isoFieldKey(g)) requestIso(iso);
});
// The worker could not be started or loaded (e.g. an old cached module): from now on compute on the main thread
for (const type of ['error', 'messageerror']) {
  isoWorker?.addEventListener(type, (e) => {
    console.warn(`Isosurface worker ${type}, computing on the main thread from now on`, e);
    isoWorkerFailed = true;
    const waiting = [...new Set(isoRequests.values())];
    isoRequests.clear();
    for (const iso of waiting) {
      iso.busy = false;
      if (state.isos.includes(iso)) buildIso(iso);
    }
  });
}

function requestIso(iso) {
  const g = state.grid;
  iso.wanted = iso.value;
  if (iso.busy) return; // the result handler asks again for the newest value
  const key = isoFieldKey(g);
  sendFieldToWorker(g, key);
  const id = ++isoRequest;
  iso.busy = true;
  isoRequests.set(id, iso);
  iso.el.info.textContent = 'computing…';
  isoWorker.postMessage({ type: 'build', id, key, value: iso.value });
}

function buildIso(iso) {
  const g = state.grid;
  if (!g || !iso.visible || g.nz < 2) {
    disposeIso(iso);
    iso.el.info.textContent = g && g.nz < 2 ? 'need ≥ 2 levels' : '';
    return;
  }
  if (!isoGroup.visible) {
    // Only the volume is shown: compute the surface when it is shown
    disposeIso(iso);
    iso.dirty = true;
    iso.el.info.textContent = 'computed when the isosurface is shown';
    return;
  }
  iso.dirty = false;
  if (isoWorker && !isoWorkerFailed && g.nx * g.ny * g.nz >= WORKER_MIN_POINTS) {
    requestIso(iso);
    return;
  }
  computeIsoHere(iso);
}

function computeIsoHere(iso) {
  const g = state.grid;
  const { px, py, pz } = state.geo;
  const t0 = performance.now();
  try {
    const r = marchingCubes(g.data[g.param], g.nx, g.ny, g.nz, iso.value, px, py, pz);
    showIsoResult(iso, r, performance.now() - t0);
  } catch (e) {
    console.error(e);
    disposeIso(iso);
    iso.el.info.textContent = `isosurface failed: ${e.message}`;
  }
}

function showIsoResult(iso, r, ms) {
  disposeIso(iso);
  requestRender();
  const tris = r.indices.length / 3;
  iso.el.info.textContent = tris ? `${tris.toLocaleString()} triangles · ${ms.toFixed(0)} ms` : 'value not crossed in this cube';
  if (!tris) return;
  if (globe) {
    // Normals first: they are turned at the flat position of their vertex
    const P = r.positions, N = r.normals, out = [];
    for (let n = 0; n < P.length; n += 3) {
      globe.mapNormal(P[n], P[n + 1], P[n + 2], N[n], N[n + 1], N[n + 2], out);
      N[n] = out[0]; N[n + 1] = out[1]; N[n + 2] = out[2];
    }
    placeAll(P);
  }
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

// Particle starting points follow the threshold, but only once the slider settles: on a large grid finding
// them takes a moment
let streamlineTimer = 0;
function scheduleStreamlines() {
  clearTimeout(streamlineTimer);
  streamlineTimer = setTimeout(() => { if (state.grid?.wind) { buildStreamlines(); requestRender(); } }, 250);
}

function updateIsoLines() {
  if (state.grid?.wind) scheduleStreamlines();
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
  if (sliceUniforms.cmap.value.userData.name !== name) { // a new texture only for another colour map
    sliceUniforms.cmap.value.dispose();
    sliceUniforms.cmap.value = makeColormapTexture(name);
    sliceUniforms.cmap.value.userData.name = name;
  }
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
  // On the globe at most the size for a 6000 km area: global data would otherwise get labels of 1000 km
  const size = globe ? Math.min(ext, 6000) : ext;
  const s = vscale(), h = size * 0.028, z0 = zmin * s, pad = size * 0.04;
  // On the globe, data reaching far towards a pole gets its longitude labels along the latitude nearest the
  // equator (not at the pole, where they would all meet), and data all around the Earth its latitude labels
  // along the meridian nearest 0° and its levels at the equator
  const nearPole = globe && (lats[0] < -60 || lats.at(-1) > 60), allAround = globe && lons.at(-1) - lons[0] > 300;
  const clampTo = (v, a, b) => Math.min(Math.max(v, a), b);
  const lonLabelY = nearPole ? (clampTo(0, lats[0], lats.at(-1)) - lat0) * ky : py[0] - pad;
  const latLabelX = allAround ? (clampTo(0, lons[0], lons.at(-1)) - lon0) * kx : px[0] - pad * 1.6;
  const add = (text, x, y, z) => {
    const l = makeLabel(text, h);
    if (globe) l.position.fromArray(globe.place(x, y, z / s)); // z comes scaled; the globe scales it itself
    else l.position.set(x, y, z);
    labelGroup.add(l);
  };
  const lonStep = niceStep(lons.at(-1) - lons[0], 6);
  for (let l = Math.ceil(lons[0] / lonStep) * lonStep; l <= lons.at(-1); l += lonStep) add(axisText(`${+l.toFixed(2)}`, 'x'), (l - lon0) * kx, lonLabelY, z0);
  const latStep = niceStep(lats.at(-1) - lats[0], 6);
  for (let l = Math.ceil(lats[0] / latStep) * latStep; l <= lats.at(-1); l += latStep) add(axisText(`${+l.toFixed(2)}`, 'y'), latLabelX, (l - lat0) * ky, z0);

  // Vertical axis on the north-west corner; for data reaching a pole, on the west edge at the latitude nearest the equator
  const x = allAround ? latLabelX : px[0] - pad, y = nearPole ? lonLabelY : py.at(-1) + pad;
  const vkind = state.grid.vkind;
  if (allAround) {
    // All around the Earth: level labels at one spot would only pile up in front of the data
  } else if (vkind === 'pressure' || vkind === 'height') {
    // A label per level at its height, skipping levels too close to the previous label
    const text = VERTICAL_KINDS[vkind].text;
    let lastZ = -Infinity;
    for (let k = levels.length - 1; k >= 0; k--) {
      const z = state.geo.pz[k * state.grid.nx * state.grid.ny] * s;
      if (z - lastZ < 1.4 * h && k !== 0) continue;
      add(text(levels[k]), x, y, z);
      lastZ = z;
    }
  } else if (vmode === 'pressure') {
    const kmMax = zmax / KM_SCALE, step = niceStep(kmMax, Math.max(1, Math.min(8, Math.floor((zmax * s) / (1.4 * h)))));
    for (let km = 0; km <= kmMax; km += step) add(`${km} km`, x, y, km * KM_SCALE * s);
  } else {
    // Pick a level step that leaves at least ~1.4 label heights between labels.
    const nz = levels.length, room = (nz - 1) * levelSpacing * s;
    const step = [1, 2, 5, 10, 20, 40, 80].find((st) => room / Math.max(1, (nz - 1) / st) >= 1.4 * h) ?? 100;
    for (let k = 0; k < nz; k++) {
      const end = k === 0 || k === nz - 1, nearEnd = Math.min(k, nz - 1 - k) < step / 2;
      // Round level numbers when every level is loaded; with a vertical step every step-th loaded level
      const pick = levels[1] - levels[0] > 1 ? k % step === 0 : levels[k] % step === 0;
      if (end || (pick && !nearEnd)) add(`L${levels[k]}`, x, y, (nz - 1 - k) * levelSpacing * s);
    }
  }
}

let globeRebuildTimer = 0;
function applyVScale() {
  const s = vscale();
  $('vscale').nextElementSibling.textContent = `×${s.toFixed(s < 1 ? 2 : 1)}`;
  if (globe && globe.vscale !== s) {
    // On the globe the vertical scale is part of every placed point: rebuild once the slider settles
    clearTimeout(globeRebuildTimer);
    globeRebuildTimer = setTimeout(() => state.grid && rebuildAll(), 150);
  } else if (!globe) {
    dataGroup.scale.z = s;
  }
  // The labels depend on the grid layout (kept in state.geo), the vertical scale and the globe, not on the time
  // (on the globe the mapper, which carries the vertical scale; it is replaced when that changes)
  if (labelsBuilt.geo !== state.geo || labelsBuilt.s !== s || labelsBuilt.globe !== globe || !labelGroup.children.length) {
    buildLabels();
    Object.assign(labelsBuilt, { geo: state.geo, s, globe });
  }
  syncViewControls();
}
const labelsBuilt = { geo: null, s: 0, globe: null };

// Data covering a large part of the Earth on the globe: the view is centred on the Earth itself, with north up
// (orbiting, and flying around, about the Earth's axis), instead of on the data with its local vertical up
function earthCentred() {
  if (!globe || !state.grid || !state.geo) return false;
  const [w, s, e, n] = dataLonLatBounds();
  return e - w >= 150 || n - s >= 100;
}
const SCENE_Z = new THREE.Vector3(0, 0, 1), ORBIT_Y = new THREE.Vector3(0, 1, 0);
// The Earth's axis (towards the north pole) in the scene
function northAxis(out = new THREE.Vector3()) {
  const { frame } = state.geo;
  return out.set(frame.x[2], frame.y[2], frame.up[2]).normalize();
}
// The camera's up direction, which is also the axis the orbit controls turn about
function setOrbitUp(up) {
  if (camera.up.equals(up)) return;
  camera.up.copy(up);
  controls._quat.setFromUnitVectors(camera.up, ORBIT_Y); // OrbitControls computes these once, from camera.up
  controls._quatInverse.copy(controls._quat).invert();
}

// view (optional, e.g. from a preset): { azimuth (where the camera is, degrees clockwise from grid north),
// elevation (degrees above the horizontal), distance (× the fitted distance) }
function fitCamera(view = null) {
  stopFlight(); // a new view starts at rest, with the mouse
  if (flight.active) {
    flight.active = false;
    controls.enabled = true;
  }
  if (!state.geo) return;
  if (globe && earthCentred()) {
    // Most of the Earth: looking at its centre from above the data's longitude, near the equator, north up
    const north = northAxis();
    setOrbitUp(north);
    const centre = new THREE.Vector3(...globe.centre), { frame } = state.geo;
    const v = ecefOf(frame.lon, 12); // a little north of the equator
    const dir = new THREE.Vector3(dot(frame.x, v), dot(frame.y, v), dot(frame.up, v)).normalize();
    const d = earthFitDistance();
    controls.target.copy(centre);
    camera.position.copy(centre).addScaledVector(dir, d);
    camera.near = d / 500;
    camera.far = Math.max(d * 20, EARTH_RADIUS * 12);
    camera.updateProjectionMatrix();
    controls.update();
    return;
  }
  setOrbitUp(SCENE_Z);
  if (globe) {
    // Around the curved data, with the far plane beyond the whole Earth
    const sphere = dataBounds(tmpBox).getBoundingSphere(tmpSphere);
    const d = sphere.radius * 2.2;
    controls.target.copy(sphere.center);
    camera.position.set(sphere.center.x - d * 0.35, sphere.center.y - d * 0.95, sphere.center.z + d * 0.55);
    if (view) placeCamera(view, sphere.center, d);
    camera.near = d / 500;
    camera.far = Math.max(d * 20, EARTH_RADIUS * 12);
  } else {
    const { ext, zmin, zmax } = state.geo;
    const s = vscale(), zmid = ((zmin + zmax) / 2) * s;
    const d = Math.max(ext, (zmax - zmin) * s) * 1.5;
    controls.target.set(0, 0, zmid);
    camera.position.set(-d * 0.35, -d * 0.95, zmid + d * 0.55);
    if (view) placeCamera(view, controls.target, d);
    camera.near = d / 500;
    camera.far = d * 20;
  }
  camera.updateProjectionMatrix();
  controls.update();
}

function placeCamera({ azimuth = 200, elevation = 28.5, distance = 1 }, target, d) {
  const az = THREE.MathUtils.degToRad(azimuth), el = THREE.MathUtils.degToRad(elevation), r = d * 1.14 * distance; // 1.14: the default offset
  camera.position.set(target.x + r * Math.sin(az) * Math.cos(el), target.y + r * Math.cos(az) * Math.cos(el), target.z + r * Math.sin(el));
}

// The controls in the 3D view mirror panel controls: the parameter shown, the first isosurface value and the
// vertical scale. They change the panel controls, which stay the single source of truth.
function syncViewControls() {
  const keep = (el) => el === document.activeElement; // do not overwrite what the user is typing or dragging
  // Copies the options of a panel select and shows the loaded value (or the panel value before anything is loaded)
  const mirror = (src, sel, shown) => {
    const same = sel.options.length === src.options.length && [...src.options].every((o, n) => sel.options[n].value === o.value);
    if (!same) {
      sel.innerHTML = '';
      for (const o of src.options) sel.append(option(o.value, o.textContent));
    }
    if (!keep(sel)) sel.value = shown != null && [...src.options].some((o) => o.value === shown) ? shown : src.value;
  };
  mirror($('parameter'), $('vcParam'), state.grid?.selection ?? state.grid?.param);
  // Streamlines toggle, only for the derived wind
  $('vcStreamWrap').hidden = !state.grid?.wind;
  const sameInstance = state.grid && state.grid.instance === $('instance').value;
  mirror($('datetime'), $('vcTime'), sameInstance ? state.grid.datetime : null);
  const t = $('vcTime');
  $('vcTimePrev').disabled = t.selectedIndex <= 0;
  $('vcTimeNext').disabled = t.selectedIndex < 0 || t.selectedIndex >= t.options.length - 1;
  $('vcStop').disabled = !anim.playing && t.value === firstTime(); // already at the start

  const iso = state.isos[0];
  $('vcThresholdWrap').hidden = !iso;
  if (iso) {
    const range = $('vcThreshold'), num = $('vcThresholdNum');
    for (const a of ['min', 'max', 'step']) range[a] = iso.el.range[a];
    num.step = iso.el.range.step;
    if (!keep(range)) range.value = iso.value;
    if (!keep(num)) num.value = iso.value;
    $('vcUnit').textContent = state.grid?.unit || '';
  }

  // Render style: isosurface, or the volume with its style ('both' shows as the volume style)
  if (!keep($('vcRender'))) $('vcRender').value = $('renderMode').value === 'iso' ? 'iso' : `vol-${$('volStyle').value}`;

  // Volume density, only for the volume
  $('vcDensityWrap').hidden = $('renderMode').value === 'iso';
  if (!keep($('vcDensity'))) $('vcDensity').value = $('volDensity').value;
  $('vcDensityOut').textContent = $('volDensity').nextElementSibling.textContent;

  if (!keep($('vcVscale'))) $('vcVscale').value = $('vscale').value;
  $('vcVscaleOut').textContent = `×${vscale().toFixed(vscale() < 1 ? 2 : 1)}`;
}

// "levels 1–90", "levels 1–88 every 3", "300–850 hPa (3 levels)", "10000–100 m (9 levels)"
function levelsText(g) {
  const first = g.levels[0], last = g.levels.at(-1);
  if (g.vkind === 'pressure' || g.vkind === 'height') return `${first}–${last} ${VERTICAL_KINDS[g.vkind].unit} (${g.nz} levels)`;
  const step = g.nz > 1 ? g.levels[1] - g.levels[0] : 1;
  return `levels ${first}–${last}${step > 1 ? ` every ${step}` : ''}`;
}

// The HUD describes the loaded time: in-between frames (shown on the time line) leave it as it is, so it does not
// change several times a second while animating
function updateHud() {
  syncViewControls();
  const g = state.grid;
  if (!g) { $('hud').innerHTML = ''; return; }
  if (g.shownTime) return;
  const isoTxt = state.isos.filter((i) => i.visible).map((i) => `${fmt(i.value)} ${g.unit}`).join(', ');
  $('hud').innerHTML =
    `<b>${g.wind ? `wind (${g.wind.speed} + ${g.wind.dir})` : g.param}</b> · ${g.datetime || ''}<br>` +
    `run ${g.instance || '–'} · ${levelsText(g)} · ${g.nx}×${g.ny}×${g.nz}` +
    `${g.proj ? ' · native rotated pole grid' : ''}<br>` +
    `read ${fmtCount(g.valuesRead)} values (${g.sourceSize.join('×')} × ${g.nz} levels${Object.keys(g.data).length > 1 ? ` × ${Object.keys(g.data).length} parameters` : ''})` +
    `${g.valuesMissing ? `, ${fmtCount(g.valuesMissing)} without data` : ''}` +
    `${g.stride > 1 ? ` · shown as ${fmtCount(g.nx * g.ny * g.nz)} points (${g.stride}×${g.stride} averaged)` : ''}<br>` +
    `range ${fmt(g.min)} … ${fmt(g.max)} ${g.unit}` + (isoTxt ? `<br>isosurface ${isoTxt}` : '') +
    (sunState.dir ? `<br>sun ${sunState.elevation >= 0 ? `${fmt(sunState.elevation, 0)}° above` : `${fmt(-sunState.elevation, 0)}° below`} the horizon, azimuth ${fmt(sunState.azimuth, 0)}°` : '') +
    (moonState.dir ? `<br>moon ${moonState.elevation >= 0 ? `${fmt(moonState.elevation, 0)}° above` : `${fmt(-moonState.elevation, 0)}° below`} the horizon, ${fmt(moonState.illuminated * 100, 0)}% lit` : '');
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
  const x = lerpArr(g.lons, ijk.x), y = lerpArr(g.lats, ijk.y);
  const [lon, lat] = g.proj ? g.proj.toGeo(x, y) : [x, y];
  const lines = [
    `<b>${fmt(value, 2)} ${g.unit}</b>${iso ? ' (isosurface)' : ''}`,
    `${fmt(lon, 3)}°E ${fmt(lat, 3)}°N`,
    ...(g.proj ? [`grid ${fmt(x, 3)}° rlon ${fmt(y, 3)}° rlat`] : []),
    g.vkind === 'pressure' || g.vkind === 'height'
      ? `${fmt(lerpArr(g.levels, ijk.z), 0)} ${VERTICAL_KINDS[g.vkind].unit}`
      : `model level ${fmt(lerpArr(g.levels, ijk.z), 1)}`,
  ];
  if (g.wind) {
    const n = (Math.round(ijk.z) * g.ny + Math.round(ijk.y)) * g.nx + Math.round(ijk.x);
    const d = g.data[g.wind.dir][n];
    if (d === d) lines.splice(1, 0, `wind from ${fmt(d, 0)}°`);
  }
  const p = g.data[g.pressureParam];
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

async function applyPreset(p) {
  if (p.collectionUrl && p.collectionUrl !== state.collectionUrl) {
    state.abort?.abort();
    $('collectionUrl').value = p.collectionUrl;
    try {
      await loadCollection(p.collectionUrl, { parameter: p.parameter, crs: p.crs });
    } catch (e) {
      console.error(e);
      // Nothing of the new collection was loaded: show the URL of the one still shown, not the one that failed
      $('collectionUrl').value = state.collectionUrl || '';
      setStatus(`Could not open ${p.collectionUrl} (${e.message}); still showing ${state.collectionUrl || 'nothing'}`, true);
      return;
    }
  }
  if (!state.collection) {
    setStatus('Collection metadata not loaded yet', true);
    return;
  }
  if (p.crs != null) {
    if (p.crs === 'native' && !state.native) {
      setStatus('This collection does not offer its native grid (crs=native)', true);
      return;
    }
    $('gridCrs').value = p.crs === 'native' ? state.native.crs : '';
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
  if (p.levelStep != null) $('levelStep').value = String(p.levelStep);
  if (p.levelsPerRequest != null) $('levelsPerRequest').value = p.levelsPerRequest;
  $('serverResolution').value = p.resolution ? p.resolution.join('x') : ''; // presets without it use the server's grid
  if (p.gridCells != null) $('gridOn').checked = p.gridCells; // drawn when the data is shown
  if (p.earth != null) $('earthOn').checked = p.earth;
  if (p.globe != null) $('globeOn').checked = p.globe;
  if (p.baseLayer != null && [...$('baseLayer').options].some((o) => o.value === p.baseLayer)) $('baseLayer').value = p.baseLayer;
  if (p.sun != null) $('sunOn').checked = p.sun;
  if (p.starNames != null) $('starNamesOn').checked = p.starNames;
  if (p.tween != null) $('tweenStep').value = String(p.tween);
  if (p.tour != null && !p.tour && tour.active) stopTour();
  if (p.sky != null) {
    $('skyOn').checked = p.sky;
    skyGroup.visible = celestialGroup.visible = p.sky;
  }
  if (p.concurrency != null) $('concurrency').value = p.concurrency;
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
  if (p.density != null) $('volDensity').value = Math.log10(p.density); // the slider is logarithmic
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
  if (!(await loadData())) return; // not loaded: the view stays as it was
  fitCamera(p.view); // a preset starts with its own view (or the default one)
  if (p.tour) {
    $('vcTour').checked = true;
    startTour();
  }
}

for (const p of PRESETS) {
  const b = document.createElement('button');
  b.innerHTML = `${p.name}<small>${p.description}</small>`;
  b.addEventListener('click', () => applyPreset(p));
  $('presetList').append(b);
}
$('load').addEventListener('click', () => loadData()); // from the caches when there
$('cancel').addEventListener('click', () => { stopAnimation(); state.abort?.abort(); });
// Reads the collection in the URL field when it is not the loaded one, keeping the current choices where possible.
// The URL field takes an EDR endpoint (…/edr) or a collection URL (…/edr/collections/{id}). An endpoint lists
// its collections that have at least two levels and a cube query, and opens the current one if it is among
// them, otherwise the first. Any opened collection lists its neighbours, so you can switch between them.
const COLLECTION_URL = /^(.*)\/collections\/([^/?#]+)\/?$/;
const collectionLists = new Map(); // endpoint → promise of [{ id, url, label }]

function listCollections(endpoint) {
  if (!collectionLists.has(endpoint)) {
    const promise = fetchJSON(`${endpoint}/collections`, { retries: 1 }).then((json) => (json.collections || [])
      .filter((c) => (c.extent?.vertical?.values?.length ?? 0) >= 2 && (!c.data_queries || c.data_queries.cube))
      .map((c) => {
        const v = verticalOf(c);
        const range = v.values.length ? ` (${v.values.at(-1) === v.values[0] ? v.values[0] : `${Math.min(...v.values)}–${Math.max(...v.values)}`}${v.unit ? ` ${v.unit}` : ''})` : '';
        return { id: c.id, url: `${endpoint}/collections/${encodeURIComponent(c.id)}`, label: `${c.title && c.title !== c.id ? `${c.title} – ` : ''}${c.id}: ${v.values.length} ${v.label}${range}` };
      })
      .sort((a, b) => a.id.localeCompare(b.id)));
    promise.catch(() => collectionLists.delete(endpoint)); // try again next time
    collectionLists.set(endpoint, promise);
  }
  return collectionLists.get(endpoint);
}

function fillCollectionList(items, selectedUrl) {
  const sel = $('collectionList');
  sel.innerHTML = '';
  for (const item of items) sel.append(option(item.url, item.label));
  if (selectedUrl && !items.some((i) => i.url === selectedUrl)) sel.prepend(option(selectedUrl, `${selectedUrl.split('/').pop()} (not in the list)`));
  if (selectedUrl) sel.value = selectedUrl;
  $('collectionListWrap').hidden = sel.options.length === 0;
  $('collectionListCount').textContent = `${items.length} with levels`;
}

// Shows the neighbours of an opened collection in the list (in the background; failures only hide the list)
async function showCollectionNeighbours(collectionUrl) {
  const m = COLLECTION_URL.exec(collectionUrl);
  if (!m) return;
  try {
    const items = await listCollections(m[1]);
    if (state.collectionUrl === collectionUrl) fillCollectionList(items, collectionUrl);
  } catch (e) {
    console.warn('Could not list the collections of', m[1], e);
  }
}

async function openCollection({ loadAfter = false } = {}) {
  const text = $('collectionUrl').value.trim().replace(/\/+$/, '');
  if (!text) {
    setStatus('Enter an EDR endpoint or collection URL', true);
    return;
  }
  if (COLLECTION_URL.test(text)) {
    await openCollectionUrl(text, { loadAfter });
    return;
  }
  // An endpoint: list its collections with levels
  const endpoint = text.replace(/\/collections$/, '');
  setStatus(`Listing the collections of ${endpoint}…`);
  let items;
  try {
    items = await listCollections(endpoint);
  } catch (e) {
    console.error(e);
    setStatus(`Could not list the collections of ${endpoint} (${e.message})`, true);
    return;
  }
  if (!items.length) {
    setStatus(`${endpoint} has no collections with levels`, true);
    return;
  }
  const choice = items.find((i) => i.url === state.collectionUrl) || items[0];
  fillCollectionList(items, choice.url);
  setStatus(`${items.length} collections with levels at ${endpoint}`);
  await openCollectionUrl(choice.url, { loadAfter });
}

async function openCollectionUrl(url, { loadAfter = false } = {}) {
  try {
    if (url !== state.collectionUrl) {
      // Enter followed by leaving the field must not read the collection twice
      if (state.openingCollection?.url !== url) {
        const prefer = { parameter: $('parameter').value, datetime: $('datetime').value, crs: $('gridCrs').value || undefined };
        state.openingCollection = { url, promise: loadCollection(url, prefer) };
      }
      const opening = state.openingCollection;
      try {
        await opening.promise;
      } finally {
        if (state.openingCollection === opening) state.openingCollection = null;
      }
      setStatus('Collection loaded');
    }
    if (loadAfter) await loadData();
  } catch (e) {
    console.error(e);
    setStatus(e.message, true);
  }
}
$('collectionList').addEventListener('change', () => openCollectionUrl($('collectionList').value, { loadAfter: true }));
$('openCollection').addEventListener('click', () => openCollection({ loadAfter: true }));
$('collectionUrl').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault(); // a URL has no line breaks
  openCollection({ loadAfter: true });
});
$('collectionUrl').addEventListener('change', () => openCollection());
$('instance').addEventListener('change', () => updateDatetimes());
$('vmode').addEventListener('change', () => {
  if (state.grid && (state.grid.data[state.grid.pressureParam] || $('vmode').value === 'level')) {
    state.grid.vmode = $('vmode').value;
    rebuildAll();
    fitCamera();
  } else if (state.grid) {
    setStatus(`Pressure altitude needs ${pressureParamOf(state.collection)} — press Load`);
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
$('cancel2').addEventListener('click', () => { stopAnimation(); state.abort?.abort(); });
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

// Controls in the 3D view: they set the panel controls and fire the same events
$('vcParam').addEventListener('change', () => {
  $('parameter').value = $('vcParam').value;
  loadData();
});
$('parameter').addEventListener('change', syncViewControls);
const showTime = (value) => {
  if (!value) return;
  $('datetime').value = value;
  $('vcTime').value = value;
  syncViewControls();
  return loadData();
};
$('vcTime').addEventListener('change', () => showTime($('vcTime').value));
$('vcTimePrev').addEventListener('click', () => showTime($('vcTime').options[$('vcTime').selectedIndex - 1]?.value));
$('vcTimeNext').addEventListener('click', () => showTime($('vcTime').options[$('vcTime').selectedIndex + 1]?.value));
$('datetime').addEventListener('change', syncViewControls);
$('vcStream').addEventListener('change', buildStreamlines);
for (const id of ['renderMode', 'volStyle', 'volWidth']) $(id).addEventListener('input', scheduleStreamlines);
$('vcRender').addEventListener('change', () => {
  const v = $('vcRender').value;
  if (v === 'iso') {
    $('renderMode').value = 'iso';
  } else {
    $('renderMode').value = 'volume';
    $('volStyle').value = v.slice(4);
  }
  applyRenderMode();
  updateVolumeSettings();
  syncViewControls();
});
$('renderMode').addEventListener('change', syncViewControls);
$('volStyle').addEventListener('input', syncViewControls);
$('vcPlay').addEventListener('click', () => (anim.playing ? stopAnimation() : startAnimation()));
// Tape deck: ⏹ ends the animation at the first time
// ⏹ goes back to the first time of the animation loop (of the run, without a loop)
function firstTime() {
  const l = anim.loop, opts = $('vcTime').options;
  return (l && l.instance === $('instance').value && l.count === opts.length ? opts[l.start] : opts[0])?.value;
}
$('vcStop').addEventListener('click', async () => {
  const playing = anim.playing;
  await showTime(firstTime());
  if (playing) setStatus('Animation stopped, back at the first time of the loop');
});
$('vcSteps').addEventListener('change', () => updateLoadBlocks());
const setThreshold = (value) => {
  const iso = state.isos[0];
  if (!iso || !Number.isFinite(value)) return;
  iso.el.num.value = value;
  iso.el.num.dispatchEvent(new Event('input')); // same path as typing in the panel: rebuilds surface, lines and volume
};
$('vcThreshold').addEventListener('input', () => {
  $('vcThresholdNum').value = $('vcThreshold').value;
  setThreshold(Number($('vcThreshold').value));
});
$('vcThresholdNum').addEventListener('input', () => {
  $('vcThreshold').value = $('vcThresholdNum').value;
  setThreshold(Number($('vcThresholdNum').value));
});
$('vcDensity').addEventListener('input', () => {
  $('volDensity').value = $('vcDensity').value;
  updateVolumeSettings();
  syncViewControls();
});
$('volDensity').addEventListener('input', syncViewControls);
$('vcVscale').addEventListener('input', () => {
  $('vscale').value = $('vcVscale').value;
  applyVScale();
});
$('bordersOn').addEventListener('change', () => (mapGroup.visible = $('bordersOn').checked));
$('baseLayer').addEventListener('change', () => { buildGround(); buildEarth(); });
$('earthOn').addEventListener('change', buildEarth);
$('mapBrightness').addEventListener('input', () => {
  const mat = groundGroup.children[0]?.material;
  if (mat?.map) mat.color.setScalar(Number($('mapBrightness').value));
  const earthMat = earthGroup.children[0]?.material;
  if (earthMat?.map) earthMat.color.setScalar(Number($('mapBrightness').value) * EARTH_BRIGHTNESS);
});
$('gridOn').addEventListener('change', buildGridCells);
$('skyOn').addEventListener('change', () => (skyGroup.visible = celestialGroup.visible = $('skyOn').checked));
$('sunOn').addEventListener('change', updateSun);
// Local cache: the limit is remembered in this browser
try { const v = localStorage.getItem('localCache'); if (v != null && [...$('localCache').options].some((o) => o.value === v)) $('localCache').value = v; } catch { /* default */ }
$('localCache').addEventListener('change', async () => {
  try { localStorage.setItem('localCache', $('localCache').value); } catch { /* not remembered */ }
  // Off keeps what is stored (Clear removes it); a lower limit drops the oldest times right away
  if (localCacheLimit() > 0) try { await evictFrames(localCacheLimit()); } catch { /* not available */ }
  updateLocalCacheInfo(0);
});
// Clear: the local cache and the times in memory, so Load gets them from the server again (the shown time stays
// on screen)
$('clearCache').addEventListener('click', async () => {
  try { await clearFrames(); } catch (e) { console.warn('Could not clear the local cache', e); }
  frameCache.clear();
  frameCacheBytes = 0;
  updateLocalCacheInfo(0);
  setStatus('Cache cleared: times are loaded from the server again');
});
updateLocalCacheInfo(0);

// Background loading (Data → Load the other times in the background): while not animating, the other times of the
// run are loaded one at a time, forward from the shown time and then from the start, skipping those in memory or
// in the local cache. It waits while animating (that loads ahead itself), while times touched on the time line or
// a load from the panel are loading, and while the tab is hidden. Each time is loaded at most once per session,
// so a full memory (oldest times dropped) does not make it load them over and over. A load is never cancelled:
// the animation or the panel may be waiting for the same time.
const bgLoaded = new Set(); // request keys loaded in the background
let bgBusy = false;
function backgroundLoadTick() {
  if (bgBusy || !$('bgLoad').checked || anim.playing || document.hidden || !state.grid) return;
  if (framesLoading.size || scrubQueue.length || state.abort) return; // something else is loading
  const { iso } = timelineTimes();
  if (iso.length < 2) return;
  let keys;
  try { keys = timelineKeys(iso); } catch { return; }
  const start = Math.max(0, iso.indexOf(state.grid.datetime));
  for (let k = 1; k < iso.length; k++) {
    const n = (start + k) % iso.length, key = keys[n];
    if (bgLoaded.has(key) || frameCache.has(key) || storedKeys.has(key)) continue;
    bgLoaded.add(key);
    bgBusy = true;
    fetchFrame(buildRequest(iso[n]))
      .catch((e) => { if (e.name !== 'AbortError') console.warn('Background load of', iso[n], 'failed:', e.message); })
      .finally(() => { bgBusy = false; });
    return;
  }
}
setInterval(backgroundLoadTick, 1000);
// Off after every page load (not remembered): it can load a lot of data
$('bgLoad').checked = false;
try { localStorage.removeItem('bgLoad'); } catch { /* nothing stored */ }

$('vcTour').addEventListener('change', () => ($('vcTour').checked ? startTour() : stopTour()));

$('globeOn').addEventListener('change', () => {
  if (!state.grid) return;
  rebuildAll();
  fitCamera(); // the view around the data, flat or curved
});

// Collapsible panel, remembered in this browser (storage may be unavailable, e.g. in a private window)
function setPanelHidden(hidden) {
  document.body.classList.toggle('panel-hidden', hidden);
  $('showPanel').hidden = !hidden;
  try { localStorage.setItem('panelHidden', hidden ? '1' : '0'); } catch { /* not remembered */ }
}
$('hidePanel').addEventListener('click', () => setPanelHidden(true));
$('showPanel').addEventListener('click', () => setPanelHidden(false));
try { if (localStorage.getItem('panelHidden') === '1') setPanelHidden(true); } catch { /* default: shown */ }
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
applyPreset(PRESETS[0]); // the first preset is the start view
