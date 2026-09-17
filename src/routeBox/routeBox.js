const MODES = [
  { value: 'car', label: 'Drive' },
  { value: 'foot', label: 'Walk' },
  { value: 'bike', label: 'Bike' },
];

/**
 * Typed start/destination directions box. Geocodes each field (keyless
 * /api/geocode), enables the Directions layer, and drives its A/B endpoints so
 * a route draws and can be flown, without clicking the globe.
 */
export function createRouteBox({
  viewer,
  dataManager,
  doc = document,
  fetchImpl = (...args) => fetch(...args),
}) {
  const root = doc.createElement('div');
  root.id = 'gev-route-box';
  root.innerHTML = `
    <div class="gev-route-head">
      <span class="gev-route-title">DIRECTIONS</span>
      <button class="gev-route-collapse" type="button" title="Hide">–</button>
    </div>
    <div class="gev-route-body">
      <input class="gev-route-start" type="text" placeholder="Start (place or lat, lon)" autocomplete="off" spellcheck="false" />
      <input class="gev-route-dest" type="text" placeholder="Destination" autocomplete="off" spellcheck="false" />
      <div class="gev-route-controls">
        <select class="gev-route-mode" aria-label="Travel mode">
          ${MODES.map((m) => `<option value="${m.value}">${m.label}</option>`).join('')}
        </select>
        <button class="gev-route-swap" type="button" title="Swap start and destination">⇅</button>
        <button class="gev-route-go" type="button">ROUTE</button>
        <button class="gev-route-fly" type="button" disabled>FLY</button>
      </div>
      <div class="gev-route-status" aria-live="polite"></div>
    </div>
  `;
  doc.body.appendChild(root);

  const startEl = root.querySelector('.gev-route-start');
  const destEl = root.querySelector('.gev-route-dest');
  const modeEl = root.querySelector('.gev-route-mode');
  const goEl = root.querySelector('.gev-route-go');
  const flyEl = root.querySelector('.gev-route-fly');
  const swapEl = root.querySelector('.gev-route-swap');
  const statusEl = root.querySelector('.gev-route-status');
  const collapseEl = root.querySelector('.gev-route-collapse');

  const status = (message) => (statusEl.textContent = message || '');
  const directionsModule = () => dataManager?.layers?.get('directions')?.module;

  /** Parse "lat, lon" or geocode free text to { lat, lon, label }. */
  async function resolvePlace(text, signal) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const pair = raw.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
    if (pair) {
      const lat = Number(pair[1]);
      const lon = Number(pair[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
    }
    const response = await fetchImpl(
      `/api/geocode?q=${encodeURIComponent(raw)}`,
      { signal, cache: 'no-store' },
    );
    const data = await response.json().catch(() => null);
    const hit = data?.results?.[0];
    const loc = hit?.geometry?.location;
    if (!response.ok || !loc || !Number.isFinite(loc.lat)) return null;
    return { lat: loc.lat, lon: loc.lng, label: hit.formatted_address || raw };
  }

  let runToken = 0;
  async function route() {
    const module = directionsModule();
    if (!module) return status('Directions layer is unavailable.');
    const token = ++runToken;
    flyEl.disabled = true;
    status('Finding places…');
    let a, b;
    try {
      [a, b] = await Promise.all([
        resolvePlace(startEl.value),
        resolvePlace(destEl.value),
      ]);
    } catch {
      if (token === runToken) status('Place lookup failed. Try again.');
      return;
    }
    if (token !== runToken) return;
    if (!a) return status('Could not find the start location.');
    if (!b) return status('Could not find the destination.');
    startEl.title = a.label;
    destEl.title = b.label;
    try {
      await dataManager.setEnabled('directions', true, { origin: 'user' });
    } catch {
      /* enabling is best-effort; the module may already be on */
    }
    if (token !== runToken) return;
    module.setParams({ clear: true });
    module.setParams({ mode: modeEl.value });
    module.placeEndpoint('a', { lat: a.lat, lon: a.lon });
    module.placeEndpoint('b', { lat: b.lat, lon: b.lon });
    status(`Routing ${a.label.split(',')[0]} → ${b.label.split(',')[0]}…`);
    // The route is requested asynchronously once B lands; enable FLY optimistically.
    flyEl.disabled = false;
    setTimeout(() => {
      if (token === runToken)
        status(`${a.label.split(',')[0]} → ${b.label.split(',')[0]}`);
    }, 1200);
  }

  function fly() {
    const module = directionsModule();
    if (module) module.setParams({ fly: true });
  }

  function swap() {
    const s = startEl.value;
    startEl.value = destEl.value;
    destEl.value = s;
  }

  const onGo = () => void route();
  const onFly = () => fly();
  const onSwap = () => swap();
  const onCollapse = () => root.classList.toggle('collapsed');
  const onEnter = (event) => {
    if (event.key === 'Enter') void route();
  };
  goEl.addEventListener('click', onGo);
  flyEl.addEventListener('click', onFly);
  swapEl.addEventListener('click', onSwap);
  collapseEl.addEventListener('click', onCollapse);
  startEl.addEventListener('keydown', onEnter);
  destEl.addEventListener('keydown', onEnter);

  return {
    root,
    route,
    fly,
    destroy() {
      goEl.removeEventListener('click', onGo);
      flyEl.removeEventListener('click', onFly);
      swapEl.removeEventListener('click', onSwap);
      collapseEl.removeEventListener('click', onCollapse);
      startEl.removeEventListener('keydown', onEnter);
      destEl.removeEventListener('keydown', onEnter);
      root.remove();
    },
  };
}
