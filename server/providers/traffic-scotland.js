import { defaultSourceRoot } from './common/source-root.js';
import { createTrafficScotlandPoller } from './traffic-scotland/poller.js';
import {
  trafficScotlandCacheDir,
  trafficScotlandConfig,
} from './traffic-scotland/config.js';

/**
 * Vite plugin: background Traffic Scotland LEV poller. When FTP credentials are
 * present it pulls the camera set into a local cache no more than once every
 * 10 minutes (their rate rules), so the CCTV layer can show Scottish cameras.
 * It exposes no HTTP routes — the CCTV frame proxy reads the cache directly.
 */
function trafficScotlandProxy({ sourceRoot = defaultSourceRoot } = {}) {
  let poller = null;

  function start() {
    const config = trafficScotlandConfig();
    if (!config.enabled || poller) return;
    poller = createTrafficScotlandPoller({
      host: config.host,
      user: config.user,
      password: config.password,
      cacheDir: trafficScotlandCacheDir(sourceRoot),
      intervalMs: config.intervalMs,
    });
    void poller.start();
  }

  return {
    name: 'traffic-scotland-poller',
    configureServer() {
      start();
    },
    configurePreviewServer() {
      start();
    },
    closeBundle() {
      poller?.stop();
      poller = null;
    },
  };
}

export { trafficScotlandProxy };
