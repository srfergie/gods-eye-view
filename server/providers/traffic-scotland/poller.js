import { Client } from 'basic-ftp';
import { mkdir, writeFile, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { osgbToWgs84 } from './bng.js';

const CSV_NAME = 'cameraimages.csv';
const REMOTE_CSV = `/${CSV_NAME}`;
const REMOTE_IMAGE_DIR = '/current';
// Traffic Scotland's rules: at most ONE complete download set per 10 minutes,
// everything in a single authenticated session, always log out. Never poll
// faster than this, whatever the configured interval says.
const MIN_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Parse cameraimages.csv (PresentationName,ImageName,LocationX,LocationY) into
 * camera records with WGS84 coordinates.
 */
export function parseCameraCsv(text) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!rows.length) return [];
  const cameras = [];
  const seen = new Set();
  for (const row of rows.slice(1)) {
    // PresentationName may contain commas; the last three fields are fixed.
    const parts = row.split(',');
    if (parts.length < 4) continue;
    const y = Number(parts.pop());
    const x = Number(parts.pop());
    const image = parts.pop().trim();
    const name = parts.join(',').trim();
    if (!image || !name || seen.has(image)) continue;
    const ll = osgbToWgs84(x, y);
    if (!ll) continue;
    seen.add(image);
    cameras.push({ name, image, lat: ll.lat, lon: ll.lon });
  }
  return cameras;
}

/**
 * Compliant Traffic Scotland LEV poller: pulls the CSV and every camera image
 * in one FTP session no more than once per 10 minutes, into a local cache, then
 * logs out. Serves nothing itself — the CCTV frame proxy reads the cache.
 */
export function createTrafficScotlandPoller({
  host,
  user,
  password,
  cacheDir,
  intervalMs = MIN_INTERVAL_MS,
  log = (...args) => console.log('[traffic-scotland]', ...args),
}) {
  const currentDir = path.join(cacheDir, 'current');
  const camerasPath = path.join(cacheDir, 'cameras.json');
  const interval = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || 0);
  let timer = null;
  let running = false;
  let lastPullAt = 0;
  let cameras = [];

  async function loadCachedCameras() {
    try {
      cameras = JSON.parse(await readFile(camerasPath, 'utf8'));
    } catch {
      cameras = [];
    }
    return cameras;
  }

  async function pullOnce() {
    if (running) return; // never overlap sessions
    if (Date.now() - lastPullAt < MIN_INTERVAL_MS) return; // hard rate cap
    running = true;
    const client = new Client(30_000);
    client.ftp.verbose = false;
    try {
      await mkdir(currentDir, { recursive: true });
      await client.access({ host, user, password, secure: false });
      // One session: CSV first, then every image, then quit.
      const csv = path.join(cacheDir, CSV_NAME);
      await client.downloadTo(csv, REMOTE_CSV);
      const parsed = parseCameraCsv(await readFile(csv, 'utf8'));
      let ok = 0;
      for (const cam of parsed) {
        const dest = path.join(currentDir, cam.image);
        try {
          const tmp = `${dest}.part`;
          await client.downloadTo(tmp, `${REMOTE_IMAGE_DIR}/${cam.image}`);
          await rename(tmp, dest);
          ok += 1;
        } catch {
          /* a single missing/locked camera must not abort the set */
        }
      }
      cameras = parsed;
      await writeFile(camerasPath, JSON.stringify(parsed), 'utf8');
      lastPullAt = Date.now();
      log(`pulled ${ok}/${parsed.length} camera images`);
    } catch (error) {
      log('pull failed:', error?.message || error);
    } finally {
      client.close(); // always log out / close the session
      running = false;
    }
  }

  return {
    getCameras: () => cameras,
    cacheDir,
    currentDir,
    async start() {
      await loadCachedCameras();
      // First pull shortly after boot (offset so startup isn't hammered), then
      // on the interval. Never below the 10-minute floor.
      timer = setTimeout(function tick() {
        void pullOnce();
        timer = setTimeout(tick, interval);
      }, 4000);
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
    _pullOnceForTest: pullOnce,
  };
}
