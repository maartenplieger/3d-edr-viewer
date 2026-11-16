// Position of the sun for a moment in time, from the low-precision formulas of the Astronomical Almanac
// (about 0.01° for 1950–2050), which is plenty for lighting a scene.
const D = Math.PI / 180;

// Sun direction as a unit vector in Earth-fixed coordinates (x towards lon 0 on the equator, y towards lon 90°E,
// z towards the north pole), and the subsolar point, for a Date or ISO time string
export function sunPosition(time) {
  const ms = typeof time === 'string' ? Date.parse(time) : +time;
  const d = ms / 86400000 + 2440587.5 - 2451545.0; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * D; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude, degrees
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * D; // obliquity of the ecliptic
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)); // right ascension
  const dec = Math.asin(Math.sin(e) * Math.sin(L)); // declination
  const gmst = ((280.46061837 + 360.98564736629 * d) % 360) * D; // Greenwich mean sidereal time
  const lon = ra - gmst; // longitude of the subsolar point
  const lonDeg = ((lon / D + 540) % 360) - 180;
  return {
    lat: dec / D,
    lon: lonDeg,
    ecef: [Math.cos(dec) * Math.cos(lon), Math.cos(dec) * Math.sin(lon), Math.sin(dec)],
  };
}

// Earth-fixed unit vector of a point at lon/lat (degrees)
export const ecefOf = (lon, lat) => [Math.cos(lat * D) * Math.cos(lon * D), Math.cos(lat * D) * Math.sin(lon * D), Math.sin(lat * D)];

// Local frame at lon/lat: east, north and up as Earth-fixed unit vectors
export function enuFrame(lon, lat) {
  const sl = Math.sin(lon * D), cl = Math.cos(lon * D), sp = Math.sin(lat * D), cp = Math.cos(lat * D);
  return { east: [-sl, cl, 0], north: [-sp * cl, -sp * sl, cp], up: [cp * cl, cp * sl, sp] };
}

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// Elevation above the horizon and azimuth (clockwise from north), in degrees, of the sun seen from lon/lat
export function sunElevationAzimuth(time, lon, lat) {
  const s = sunPosition(time).ecef;
  const { east, north, up } = enuFrame(lon, lat);
  const el = Math.asin(Math.max(-1, Math.min(1, dot(s, up)))) / D;
  const az = ((Math.atan2(dot(s, east), dot(s, north)) / D) + 360) % 360;
  return { elevation: el, azimuth: az };
}
