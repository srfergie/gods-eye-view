import path from 'node:path';

/** Where the poller caches Traffic Scotland images and the parsed camera list. */
export function trafficScotlandCacheDir(sourceRoot) {
  return path.join(sourceRoot, '.gev-cache', 'traffic-scotland');
}

/** Credentials + enablement, read lazily so .env is applied first. */
export function trafficScotlandConfig() {
  const host = process.env.TRAFFIC_SCOTLAND_FTP_HOST;
  const user = process.env.TRAFFIC_SCOTLAND_FTP_USER;
  const password = process.env.TRAFFIC_SCOTLAND_FTP_PASS;
  const disabled =
    String(process.env.CCTV_TRAFFIC_SCOTLAND_ENABLED || '1').trim() === '0';
  return {
    host,
    user,
    password,
    enabled: Boolean(host && user && password) && !disabled,
    intervalMs: Number(process.env.TRAFFIC_SCOTLAND_INTERVAL_MS) || undefined,
  };
}

/** Camera id prefix; the remainder is the cached image filename. */
export const TS_ID_PREFIX = 'ts-';
export const TS_SOURCE_KIND = 'traffic-scotland';
