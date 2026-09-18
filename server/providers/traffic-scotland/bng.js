// British National Grid (OSGB36, EPSG:27700) easting/northing -> WGS84 lat/lon.
// Airy 1830 transverse Mercator inverse, then a 7-parameter Helmert transform
// OSGB36 -> WGS84 (~5 m accuracy, ample for placing camera markers).

const deg = (r) => (r * 180) / Math.PI;
const rad = (d) => (d * Math.PI) / 180;

/** @returns {{lat:number, lon:number}|null} */
export function osgbToWgs84(E, N) {
  if (!Number.isFinite(E) || !Number.isFinite(N)) return null;
  const a = 6377563.396;
  const b = 6356256.909;
  const F0 = 0.9996012717;
  const lat0 = rad(49);
  const lon0 = rad(-2);
  const N0 = -100000;
  const E0 = 400000;
  const e2 = 1 - (b * b) / (a * a);
  const n = (a - b) / (a + b);

  let lat = lat0;
  let M = 0;
  for (let i = 0; i < 100; i++) {
    lat = (N - N0 - M) / (a * F0) + lat;
    const Ma = (1 + n + 1.25 * n * n + 1.25 * n ** 3) * (lat - lat0);
    const Mb =
      (3 * n + 3 * n * n + 2.625 * n ** 3) *
      Math.sin(lat - lat0) *
      Math.cos(lat + lat0);
    const Mc =
      (1.875 * n * n + 1.875 * n ** 3) *
      Math.sin(2 * (lat - lat0)) *
      Math.cos(2 * (lat + lat0));
    const Md =
      (35 / 24) *
      n ** 3 *
      Math.sin(3 * (lat - lat0)) *
      Math.cos(3 * (lat + lat0));
    M = b * F0 * (Ma - Mb + Mc - Md);
    if (Math.abs(N - N0 - M) < 1e-5) break;
  }

  const slat = Math.sin(lat);
  const nu = (a * F0) / Math.sqrt(1 - e2 * slat * slat);
  const rho = (a * F0 * (1 - e2)) / (1 - e2 * slat * slat) ** 1.5;
  const eta2 = nu / rho - 1;
  const tlat = Math.tan(lat);
  const sec = 1 / Math.cos(lat);
  const VII = tlat / (2 * rho * nu);
  const VIII =
    (tlat / (24 * rho * nu ** 3)) *
    (5 + 3 * tlat ** 2 + eta2 - 9 * tlat ** 2 * eta2);
  const IX =
    (tlat / (720 * rho * nu ** 5)) * (61 + 90 * tlat ** 2 + 45 * tlat ** 4);
  const X = sec / nu;
  const XI = (sec / (6 * nu ** 3)) * (nu / rho + 2 * tlat ** 2);
  const XII = (sec / (120 * nu ** 5)) * (5 + 28 * tlat ** 2 + 24 * tlat ** 4);
  const XIIA =
    (sec / (5040 * nu ** 7)) *
    (61 + 662 * tlat ** 2 + 1320 * tlat ** 4 + 720 * tlat ** 6);
  const dE = E - E0;
  const latAiry = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lonAiry = lon0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;
  return helmertToWgs84(deg(latAiry), deg(lonAiry));
}

/** OSGB36 (Airy) geodetic -> WGS84 geodetic via 7-parameter Helmert. */
function helmertToWgs84(latDeg, lonDeg, H = 0) {
  const toCart = (la, lo, h, a, b) => {
    la = rad(la);
    lo = rad(lo);
    const e2 = 1 - (b * b) / (a * a);
    const nu = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
    return [
      (nu + h) * Math.cos(la) * Math.cos(lo),
      (nu + h) * Math.cos(la) * Math.sin(lo),
      ((1 - e2) * nu + h) * Math.sin(la),
    ];
  };
  const toGeo = (x, y, z, a, b) => {
    const e2 = 1 - (b * b) / (a * a);
    const p = Math.hypot(x, y);
    let la = Math.atan2(z, p * (1 - e2));
    for (let i = 0; i < 10; i++) {
      const nu = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
      la = Math.atan2(z + e2 * nu * Math.sin(la), p);
    }
    return { lat: deg(la), lon: deg(Math.atan2(y, x)) };
  };
  const [x, y, z] = toCart(latDeg, lonDeg, H, 6377563.396, 6356256.909);
  const tx = 446.448;
  const ty = -125.157;
  const tz = 542.06;
  const s = -20.4894e-6;
  const rx = rad(0.1502 / 3600);
  const ry = rad(0.247 / 3600);
  const rz = rad(0.8421 / 3600);
  const x2 = tx + (1 + s) * (x - rz * y + ry * z);
  const y2 = ty + (1 + s) * (rz * x + y - rx * z);
  const z2 = tz + (1 + s) * (-ry * x + rx * y + z);
  const g = toGeo(x2, y2, z2, 6378137.0, 6356752.3141);
  return { lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) };
}
