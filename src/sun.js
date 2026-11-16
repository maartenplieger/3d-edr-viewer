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
    gmst, // radians, for the stars
  };
}

// Earth-fixed unit vector of a direction on the sky (right ascension and declination in degrees) at sidereal time
// gmst (radians): the stars turn with it
export function skyEcef(raDeg, decDeg, gmst) {
  const lon = raDeg * D - gmst, dec = decDeg * D;
  return [Math.cos(dec) * Math.cos(lon), Math.cos(dec) * Math.sin(lon), Math.sin(dec)];
}

// Position of the moon (geocentric, about 0.3° accurate) from the low-precision formulas of the Astronomical
// Almanac, as an Earth-fixed unit vector, with the illuminated fraction of its disc
export function moonPosition(time) {
  const ms = typeof time === 'string' ? Date.parse(time) : +time;
  const d = ms / 86400000 + 2440587.5 - 2451545.0;
  const T = d / 36525; // Julian centuries since J2000.0
  const sd = (a, b) => Math.sin((a + b * T) * D);
  const lambda = (218.32 + 481267.881 * T + 6.29 * sd(135.0, 477198.87) - 1.27 * sd(259.3, -413335.36) + 0.66 * sd(235.7, 890534.22)
    + 0.21 * sd(269.9, 954397.74) - 0.19 * sd(357.5, 35999.05) - 0.11 * sd(186.5, 966404.03)) * D;
  const beta = (5.13 * sd(93.3, 483202.02) + 0.28 * sd(228.2, 960400.89) - 0.28 * sd(318.3, 6003.15) - 0.17 * sd(217.6, -407332.21)) * D;
  // Ecliptic → equatorial
  const e = (23.439 - 0.00000036 * d) * D;
  const x = Math.cos(beta) * Math.cos(lambda), y = Math.cos(beta) * Math.sin(lambda), z = Math.sin(beta);
  const ye = y * Math.cos(e) - z * Math.sin(e), ze = y * Math.sin(e) + z * Math.cos(e);
  const ra = Math.atan2(ye, x), dec = Math.asin(ze);
  const sun = sunPosition(ms);
  const ecef = skyEcef(ra / D, dec / D, sun.gmst);
  // Illuminated fraction from the angle between sun and moon seen from the Earth
  const elongation = Math.acos(Math.max(-1, Math.min(1, dot(ecef, sun.ecef))));
  return { ecef, ra: ((ra / D) + 360) % 360, dec: dec / D, illuminated: (1 - Math.cos(elongation)) / 2, elongation: elongation / D };
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
