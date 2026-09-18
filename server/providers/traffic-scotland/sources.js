import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  trafficScotlandCacheDir,
  trafficScotlandConfig,
  TS_ID_PREFIX,
  TS_SOURCE_KIND,
} from './config.js';

const LICENSE =
  'Traffic Scotland Live Eye View — © Crown Copyright, licensed for use with attribution and a link to https://www.traffic.gov.scot/';

/**
 * CCTV pack loader: the Traffic Scotland cameras cached by the poller. Reads
 * the parsed cameras.json (never touches FTP here) and returns source records
 * whose frames the CCTV proxy serves from the local image cache.
 */
export async function loadTrafficScotlandSources({ sourceRoot } = {}) {
  if (!trafficScotlandConfig().enabled) return [];
  const camerasPath = path.join(
    trafficScotlandCacheDir(sourceRoot || process.cwd()),
    'cameras.json',
  );
  let cameras;
  try {
    cameras = JSON.parse(await readFile(camerasPath, 'utf8'));
  } catch {
    return []; // not pulled yet — pack stays empty until the first cycle
  }
  if (!Array.isArray(cameras)) return [];
  return cameras
    .filter(
      (c) =>
        c &&
        typeof c.image === 'string' &&
        Number.isFinite(c.lat) &&
        Number.isFinite(c.lon),
    )
    .map((c) => ({
      id: `${TS_ID_PREFIX}${c.image}`, // frame handler derives the cache file
      name: c.name,
      city: 'Scotland',
      provider: 'Traffic Scotland',
      sourceKind: TS_SOURCE_KIND,
      feedType: 'image',
      lat: c.lat,
      lon: c.lon,
      license: LICENSE,
      poseSource: 'curated',
    }));
}
