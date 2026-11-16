import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as topojson from 'topojson-client';
import { fetchJSON, parseTemporalValues, parseCubeUrl, toIso, loadCube, MAX_POINTS_PER_LEVEL } from './edr.js';
import { frameStoreUsage, clearFrames, evictFrames } from './framestore.js';
import { marchingCubes } from './isosurface.js';
import { COLORMAP_NAMES, makeColormapTexture, drawColorbar, hexToRgb } from './colormaps.js';
import { resampleVolume, createVolumeMaterial, createVolumeTexture, updateVolumeCamera } from './volume.js';
import { nativeCubeCrs, bboxToRot, bboxToGeo } from './rotpole.js';
import { Streamlines } from './streamlines.js';
import { sunPosition, moonPosition, skyEcef, enuFrame, dot } from './sun.js';
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
    tween: 10,
    view: { azimuth: 150, elevation: 30, distance: 0.95 }, // from the south-east, above the Mediterranean
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

function startFlight() {
  if (flight.active || !state.geo) return;
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
  flight.pitch += ((k('ArrowUp') - k('ArrowDown')) * FLY.maxPitch - flight.pitch) * f;
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

renderer.setAnimationLoop((now) => {
  const dt = Math.min(flyClock.getDelta(), 0.1); // capped, so a stalled frame does not jump far
  fly(dt);
  const cameraMoved = flight.active ? false : controls.update(); // while flying the plane has the camera
  updateFlightInfo(now);
  streamlines.update(dt);
  const skyMoving = advanceSkyClock(now);
  const flying = flight.active && (flyKeys.size > 0 || flightMoving());
  if (!(cameraMoved || flying || skyMoving || streamlines.object.visible || pickPending || renderFrames > 0)) return;
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

function drawLoadBlocks() {
  const el = $('loadBlocks');
  if (framesLoading.size) {
    clearTimeout(loadBlocksHide);
    loadBlocksHide = null;
    el.classList.add('visible');
  } else if (el.classList.contains('visible') && !loadBlocksHide) {
    loadBlocksHide = setTimeout(() => { el.classList.remove('visible'); loadBlocksHide = null; }, 1500);
  }
  if (!el.classList.contains('visible')) return;
  const times = [...$('datetime').options].map((o) => o.value);
  let keys;
  try {
    keys = times.map((t) => buildRequest(t).key);
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
    b.className = `lb${inMemory ? ' done' : f != null ? ' loading' : stored ? ' stored' : ''}${t === state.grid?.datetime ? ' current' : ''}`;
    b.firstChild.style.width = `${inMemory || stored ? 100 : f != null ? Math.round(f * 100) : 0}%`;
  });
  el.querySelector('.lb-label').textContent = `${loaded} of ${times.length} times in memory` +
    (local ? `, ${local} more in the local cache` : '') + (framesLoading.size ? ` · loading ${framesLoading.size}` : '');
}

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
  queueMicrotask(updateSun); // the sun follows the shown time
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
    return;
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

const anim = { playing: false, abort: null };

// While animating, the sun, moon and stars do not jump from one time to the next: the sky's time runs smoothly
// from the shown time to the next one during the frame interval, and waits there if the next one is still loading
const skyClock = { from: null, to: null, start: 0, duration: 1, shown: null, hudAt: 0 };
function skyTime() {
  const shown = state.grid?.shownTime || state.grid?.datetime; // an in-between frame has its own time
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
  updateSun({ hud: now - skyClock.hudAt > 250 }); // the HUD a few times a second
  if (now - skyClock.hudAt > 250) skyClock.hudAt = now;
  return true;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function updatePlayButton() {
  $('vcPlay').textContent = anim.playing ? '\u23F8\uFE0E' : '\u25B6\uFE0E'; // text, not emoji, symbols
  $('vcPlay').title = anim.playing ? 'Pause the animation' : 'Animate over time';
  $('vcPlay').classList.toggle('active', anim.playing);
  $('vcStop').disabled = !anim.playing && $('vcTime').selectedIndex <= 0;
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
  anim.playing = true;
  anim.abort = new AbortController();
  const { signal } = anim.abort;
  updatePlayButton();
  let index = Math.max(0, times.indexOf(state.grid?.datetime ?? $('datetime').value));
  let current = state.grid; // the grid shown for times[index]
  let shownAt = performance.now();
  holdSkyClock(times[index]);
  requestRender();
  try {
    while (anim.playing) {
      const next = (index + 1) % times.length;
      const request = buildRequest(times[next]);
      const ready = !!cachedFrame(request.key); // loading shows in the block bar in the view
      const grid = await fetchFrame(request, { signal });
      // Load the next times while this one is shown (Prefetch in the view bar)
      const ahead = Number($('vcPrefetch').value) || 1;
      for (let a = 1; a <= Math.min(ahead, times.length - 1); a++) {
        fetchFrame(buildRequest(times[(next + a) % times.length]), { signal }).catch(() => {});
      }
      if (!anim.playing) break;
      // The step to the next time starts when that one is there: from when this one was shown if it was in
      // memory already, otherwise now (the sky and the data waited at this time meanwhile)
      const stepStart = ready ? shownAt : performance.now();
      const speed = Number($('vcSpeed').value);
      startSkyClock(times[index], times[next], stepStart);
      const t0 = Date.parse(times[index]), t1 = Date.parse(times[next]);
      const tween = Number($('tweenStep').value) * 60000;
      if (tween > 0 && t1 - t0 > tween && sameShape(current, grid)) {
        // In between frames at whole multiples of the interval, following the sky's clock
        let shown = t0;
        while (anim.playing && performance.now() - stepStart < speed) {
          const t = t0 + Math.floor((skyTime() - t0) / tween) * tween;
          if (t > shown && t < t1) {
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
      $('vcAnimInfo').textContent = `${next + 1}/${times.length}`;
      setStatus(`Animating: ${times[next]} (${next + 1} of ${times.length}), ${frameCache.size} times in memory (${fmtBytes(frameCacheBytes)})`);
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
  globe = $('globeOn').checked && state.grid && state.geo ? makeGlobe(state.geo, state.grid.proj, vscale()) : null;
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

function rebuildAll() {
  computeGeo();
  updateGlobeMapper();
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
    g.crs, globe ? globe.vscale : 0, !!state.borders, $('baseLayer').value, $('earthOn').checked]);
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
  state.volume = null;
}

function buildVolume() {
  const g = state.grid;
  const placement = `${g?.nx}x${g?.ny}x${g?.nz}:${globe ? globe.vscale : 'flat'}`;
  // A new time of the same grid in the same place (same scene positions): only the values change, written into
  // the texture there is, without a new texture, mesh or shader set-up
  if (state.volume && g && state.volume.geo === state.geo && state.volume.placement === placement && $('renderMode').value !== 'iso') {
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
  if (!!volumeMaterial.defines.GLOBE !== wantGlobe) {
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
  const zg = zmin - ext * 0.0022; // just above the base map, below the borders
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

function buildBox() {
  disposeChildren(boxGroup);
  const { px, py, zmin, zmax } = state.geo;
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
  const z = zmin - ext * 0.002;
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
  const cx = (px[0] + px.at(-1)) / 2, cy = (py[0] + py.at(-1)) / 2, zg = zmin - ext * 0.003;
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

  const layer = $('baseLayer').value;
  if (!layer) return;
  const iw = 1536, ih = Math.min(2048, Math.round((iw * h) / w));
  const url = `${WMS_URL}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${encodeURIComponent(layer)}&STYLES=` +
    `&CRS=${proj ? encodeURIComponent(`PROJ4:${proj.proj4}`) : 'CRS:84'}&BBOX=${lons[0]},${lats[0]},${lons.at(-1)},${lats.at(-1)}` +
    `&WIDTH=${iw}&HEIGHT=${ih}&FORMAT=image/png&TRANSPARENT=FALSE`;
  getMapTexture(url).then((tex) => {
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
  getMapTexture(url, 'earth').then((tex) => {
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
function buildGlobeEarth() {
  const { zmin, ext } = state.geo;
  const h = (zmin - ext * 0.006) * globe.vscale; // below the map under the data
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
  // Night side darker when the sun is on: the light from the direction of the sun on the radial normal
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
  mat.customProgramCacheKey = () => 'globe-earth';
  const earth = new THREE.Mesh(geom, mat);
  earth.frustumCulled = false;
  earthGroup.add(earth);

  // Degree lines every 15°
  const pts = [];
  for (let lon = -180; lon < 180; lon += 15) for (let lat = -90; lat < 90; lat += 2) pts.push(...globe.placeLonLat(lon, lat, h), ...globe.placeLonLat(lon, lat + 2, h));
  for (let lat = -75; lat <= 75; lat += 15) for (let lon = -180; lon < 180; lon += 2) pts.push(...globe.placeLonLat(lon, lat, h), ...globe.placeLonLat(lon + 2, lat, h));
  const lineGeom = new THREE.BufferGeometry();
  lineGeom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  earthGroup.add(new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0x8fa3b8, transparent: true, opacity: 0.12, depthWrite: false, fog: false })));

  // The selected base layer may cover only Europe (empty elsewhere): the globe uses a world layer, and the map
  // under the data keeps the selected one
  if (!$('baseLayer').value) return;
  const url = `${WMS_URL}SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${GLOBE_LAYER}&STYLES=` +
    '&CRS=CRS:84&BBOX=-180,-90,180,90&WIDTH=4096&HEIGHT=2048&FORMAT=image/png&TRANSPARENT=FALSE';
  getMapTexture(url, 'globe').then((tex) => {
    if (!tex || earth.parent !== earthGroup) return;
    mat.map = tex;
    mat.color.setScalar(Number($('mapBrightness').value) * 0.35); // darker than the data area, which stays on top
    mat.needsUpdate = true;
    requestRender();
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
  if (data.key === isoFieldKey(g)) showIsoResult(iso, data, data.ms);
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
    if (globe) l.position.fromArray(globe.place(x, y, z / s)); // z comes scaled; the globe scales it itself
    else l.position.set(x, y, z);
    labelGroup.add(l);
  };
  const lonStep = niceStep(lons.at(-1) - lons[0], 6);
  for (let l = Math.ceil(lons[0] / lonStep) * lonStep; l <= lons.at(-1); l += lonStep) add(axisText(`${+l.toFixed(2)}`, 'x'), (l - lon0) * kx, py[0] - pad, z0);
  const latStep = niceStep(lats.at(-1) - lats[0], 6);
  for (let l = Math.ceil(lats[0] / latStep) * latStep; l <= lats.at(-1); l += latStep) add(axisText(`${+l.toFixed(2)}`, 'y'), px[0] - pad * 1.6, (l - lat0) * ky, z0);

  const x = px[0] - pad, y = py.at(-1) + pad; // vertical axis on the north-west corner
  const vkind = state.grid.vkind;
  if (vkind === 'pressure' || vkind === 'height') {
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
  buildLabels();
  syncViewControls();
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
  $('vcStop').disabled = !anim.playing && t.selectedIndex <= 0; // already at the start

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

function updateHud() {
  syncViewControls();
  const g = state.grid;
  if (!g) { $('hud').innerHTML = ''; return; }
  const isoTxt = state.isos.filter((i) => i.visible).map((i) => `${fmt(i.value)} ${g.unit}`).join(', ');
  $('hud').innerHTML =
    `<b>${g.wind ? `wind (${g.wind.speed} + ${g.wind.dir})` : g.param}</b> · ${g.shownTime || g.datetime || ''}${g.shownTime ? ' (in between)' : ''}<br>` +
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
  if (p.sun != null) $('sunOn').checked = p.sun;
  if (p.starNames != null) $('starNamesOn').checked = p.starNames;
  if (p.tween != null) $('tweenStep').value = String(p.tween);
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
  await loadData();
  if (state.grid) fitCamera(p.view); // a preset starts with its own view (or the default one)
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
const firstTime = () => $('vcTime').options[0]?.value;
$('vcStop').addEventListener('click', async () => {
  const playing = anim.playing;
  await showTime(firstTime());
  if (playing) setStatus('Animation stopped, back at the first time');
});
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
