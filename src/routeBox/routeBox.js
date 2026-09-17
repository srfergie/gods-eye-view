import * as Cesium from 'cesium';
import { loadGoogleMaps } from '../googleMaps/loader.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from '../renderGovernor.js';

const FRAME_HOLD = 'route-frame';

const MODES = [
  { value: 'car', label: 'Drive' },
  { value: 'foot', label: 'Walk' },
  { value: 'bike', label: 'Bike' },
];
const SUGGEST_DEBOUNCE_MS = 220;
const MAX_SUGGESTIONS = 5;

/**
 * Typed start/destination directions box. Geocodes each field (keyless
 * /api/geocode), enables the Directions layer, and drives its A/B endpoints so
 * a route draws and can be flown, without clicking the globe. When a Google
 * Maps key with the Places library is available, each field offers as-you-type
 * place suggestions; otherwise it silently falls back to geocode-on-route.
 */
export function createRouteBox({
  viewer,
  dataManager,
  doc = document,
  fetchImpl = (...args) => fetch(...args),
  getApiKey = () => window.__GOOGLE_MAPS_API_KEY__,
}) {
  const root = doc.createElement('div');
  root.id = 'gev-route-box';
  root.innerHTML = `
    <div class="gev-route-head">
      <span class="gev-route-title">DIRECTIONS</span>
      <button class="gev-route-collapse" type="button" title="Hide">–</button>
    </div>
    <div class="gev-route-body">
      <div class="gev-route-field">
        <input class="gev-route-start" type="text" placeholder="Start (place or lat, lon)" autocomplete="off" spellcheck="false" />
        <ul class="gev-route-suggest" role="listbox" hidden></ul>
      </div>
      <div class="gev-route-field">
        <input class="gev-route-dest" type="text" placeholder="Destination" autocomplete="off" spellcheck="false" />
        <ul class="gev-route-suggest" role="listbox" hidden></ul>
      </div>
      <div class="gev-route-controls">
        <select class="gev-route-mode" aria-label="Travel mode">
          ${MODES.map((m) => `<option value="${m.value}">${m.label}</option>`).join('')}
        </select>
        <button class="gev-route-swap" type="button" title="Swap start and destination">⇅</button>
        <button class="gev-route-go" type="button">ROUTE</button>
        <button class="gev-route-fly" type="button" disabled>FLY</button>
        <button class="gev-route-clear" type="button" title="Clear the route" disabled>CLEAR</button>
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
  const clearEl = root.querySelector('.gev-route-clear');
  const swapEl = root.querySelector('.gev-route-swap');
  const statusEl = root.querySelector('.gev-route-status');
  const collapseEl = root.querySelector('.gev-route-collapse');

  const status = (message) => (statusEl.textContent = message || '');
  const directionsModule = () => dataManager?.layers?.get('directions')?.module;

  // --- Google Places autocomplete (optional; degrades to keyless geocode) ---
  // Prefers the new Places API (AutocompleteSuggestion), falls back to the
  // legacy AutocompleteService. `predict` returns [{ label, resolve() }].
  let placesReady = null; // Promise<adapter|false> | false
  function ensurePlaces() {
    if (placesReady !== null) return placesReady;
    const apiKey = getApiKey();
    if (!apiKey) return (placesReady = false);
    placesReady = loadGoogleMaps(apiKey, { libraries: ['places'] })
      .then((maps) => buildPlacesAdapter(maps))
      .catch(() => (placesReady = false));
    return placesReady;
  }

  /** Predict via the new Places API (places.googleapis.com). Throws if blocked. */
  function newApiPredict(maps) {
    const places = maps.places;
    let token = new places.AutocompleteSessionToken();
    return async (input) => {
      const { suggestions } =
        await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input,
          sessionToken: token,
        });
      return (suggestions || [])
        .map((s) => s.placePrediction)
        .filter(Boolean)
        .slice(0, MAX_SUGGESTIONS)
        .map((prediction) => ({
          label: prediction.text?.toString?.() || '',
          async resolve() {
            const place = prediction.toPlace();
            await place.fetchFields({
              fields: ['location', 'formattedAddress'],
            });
            token = new places.AutocompleteSessionToken();
            return {
              lat: place.location.lat(),
              lon: place.location.lng(),
              label: place.formattedAddress || prediction.text?.toString(),
            };
          },
        }));
    };
  }

  /** Predict via the legacy Places API (places-backend). Resolves to [] if blocked. */
  function legacyApiPredict(maps) {
    const places = maps.places;
    const service = new places.AutocompleteService();
    const geocoder = new maps.Geocoder();
    const token = new places.AutocompleteSessionToken();
    return (input) =>
      new Promise((resolve, reject) =>
        service.getPlacePredictions(
          { input, sessionToken: token },
          (predictions, code) => {
            if (code === places.PlacesServiceStatus.REQUEST_DENIED)
              return reject(new Error('legacy places denied'));
            if (code !== places.PlacesServiceStatus.OK) return resolve([]);
            resolve(
              (predictions || []).slice(0, MAX_SUGGESTIONS).map((p) => ({
                label: p.description,
                async resolve() {
                  const { results } = await geocoder.geocode({
                    placeId: p.place_id,
                  });
                  const loc = results?.[0]?.geometry?.location;
                  return loc
                    ? { lat: loc.lat(), lon: loc.lng(), label: p.description }
                    : null;
                },
              })),
            );
          },
        ),
      );
  }

  // Try the new Places API first, fall back to legacy — whichever the key's
  // project has enabled. Remembers the working one after the first success.
  function buildPlacesAdapter(maps) {
    const places = maps.places;
    const runners = [];
    if (places?.AutocompleteSuggestion) runners.push(newApiPredict(maps));
    if (places?.AutocompleteService) runners.push(legacyApiPredict(maps));
    if (!runners.length) return false;
    let preferred = null;
    return {
      async predict(input) {
        if (preferred) return preferred(input);
        let lastError;
        for (const run of runners) {
          try {
            const items = await run(input);
            preferred = run;
            return items;
          } catch (error) {
            lastError = error;
          }
        }
        throw lastError || new Error('places unavailable');
      },
    };
  }

  /** Wire one input to a suggestion list. Returns a per-field chosen-coord getter. */
  function attachField(inputEl, listEl) {
    let chosen = null; // { lat, lon, label } resolved from a picked suggestion
    let timer = null;
    let items = [];
    let active = -1;

    const closeList = () => {
      listEl.hidden = true;
      listEl.replaceChildren();
      items = [];
      active = -1;
    };
    const paint = () =>
      [...listEl.children].forEach((li, i) =>
        li.classList.toggle('active', i === active),
      );

    async function pick(item) {
      inputEl.value = item.label;
      closeList();
      chosen = null;
      try {
        chosen = await item.resolve();
      } catch {
        chosen = null; // fall back to keyless geocode on route()
      }
    }

    async function query(text) {
      const adapter = await ensurePlaces();
      if (!adapter || inputEl.value.trim() !== text) return;
      let predictions = [];
      try {
        predictions = await adapter.predict(text);
      } catch {
        placesReady = false; // no enabled Places API — stop trying this session
        closeList();
        return;
      }
      if (inputEl.value.trim() !== text) return;
      items = predictions;
      if (!items.length) return closeList();
      listEl.replaceChildren(
        ...items.map((item, i) => {
          const li = doc.createElement('li');
          li.textContent = item.label;
          li.setAttribute('role', 'option');
          li.addEventListener('mousedown', (event) => {
            event.preventDefault();
            void pick(item);
          });
          li.addEventListener('mouseenter', () => {
            active = i;
            paint();
          });
          return li;
        }),
      );
      active = -1;
      listEl.hidden = false;
    }

    inputEl.addEventListener('input', () => {
      chosen = null;
      const text = inputEl.value.trim();
      clearTimeout(timer);
      if (text.length < 2) return closeList();
      timer = setTimeout(() => void query(text), SUGGEST_DEBOUNCE_MS);
    });
    inputEl.addEventListener('keydown', (event) => {
      if (listEl.hidden || !items.length) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        active = (active + 1) % items.length;
        paint();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        active = (active - 1 + items.length) % items.length;
        paint();
      } else if (event.key === 'Enter' && active >= 0) {
        event.preventDefault();
        event.stopPropagation();
        void pick(items[active]);
      } else if (event.key === 'Escape') {
        closeList();
      }
    });
    inputEl.addEventListener('blur', () => setTimeout(closeList, 120));

    return { getChosen: () => chosen, close: closeList };
  }

  const startField = attachField(startEl, startEl.nextElementSibling);
  const destField = attachField(destEl, destEl.nextElementSibling);

  /** Parse "lat, lon" or geocode free text to { lat, lon, label }. */
  async function resolvePlace(text, chosen, signal) {
    if (chosen) return chosen;
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
    startField.close();
    destField.close();
    const token = ++runToken;
    flyEl.disabled = true;
    status('Finding places…');
    let a, b;
    try {
      [a, b] = await Promise.all([
        resolvePlace(startEl.value, startField.getChosen()),
        resolvePlace(destEl.value, destField.getChosen()),
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
    frameEndpoints(a, b);
    const shortA = a.label.split(',')[0];
    const shortB = b.label.split(',')[0];
    status(`Routing ${shortA} → ${shortB}…`);
    flyEl.disabled = false;
    clearEl.disabled = false;
    setTimeout(() => {
      if (token === runToken) status(`${shortA} → ${shortB}`);
    }, 1200);
  }

  /** Fly the camera to frame both endpoints so the route is in view. */
  function frameEndpoints(a, b) {
    try {
      const points = [
        Cesium.Cartesian3.fromDegrees(a.lon, a.lat),
        Cesium.Cartesian3.fromDegrees(b.lon, b.lat),
      ];
      const sphere = Cesium.BoundingSphere.fromPoints(points);
      const range = Math.max(sphere.radius * 2.4, 1500);
      // The app suspends its render loop when idle; hold it on for the flight so
      // the animation actually runs, then release when it finishes.
      holdContinuousRender(FRAME_HOLD);
      governorRequestRender('route-frame');
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseContinuousRender(FRAME_HOLD);
      };
      viewer.camera.flyToBoundingSphere(sphere, {
        duration: 2,
        offset: new Cesium.HeadingPitchRange(
          0,
          Cesium.Math.toRadians(-45),
          range,
        ),
        complete: release,
        cancel: release,
      });
      setTimeout(release, 4000); // safety net if neither callback fires
    } catch {
      releaseContinuousRender(FRAME_HOLD);
      /* framing is best-effort; the route still draws */
    }
  }

  function fly() {
    const module = directionsModule();
    if (module) module.setParams({ fly: true });
  }

  /** Remove the drawn route and reset the box to an empty state. */
  function clearRoute() {
    runToken++;
    directionsModule()?.setParams({ clear: true });
    startEl.value = '';
    destEl.value = '';
    startEl.title = '';
    destEl.title = '';
    startField.close();
    destField.close();
    flyEl.disabled = true;
    clearEl.disabled = true;
    status('');
  }

  function swap() {
    const s = startEl.value;
    startEl.value = destEl.value;
    destEl.value = s;
  }

  const onGo = () => void route();
  const onFly = () => fly();
  const onClear = () => clearRoute();
  const onSwap = () => swap();
  const onCollapse = () => root.classList.toggle('collapsed');
  const onEnter = (event) => {
    if (event.key === 'Enter' && !event.defaultPrevented) void route();
  };
  goEl.addEventListener('click', onGo);
  flyEl.addEventListener('click', onFly);
  clearEl.addEventListener('click', onClear);
  swapEl.addEventListener('click', onSwap);
  collapseEl.addEventListener('click', onCollapse);
  startEl.addEventListener('keydown', onEnter);
  destEl.addEventListener('keydown', onEnter);

  return {
    root,
    route,
    fly,
    clearRoute,
    destroy() {
      goEl.removeEventListener('click', onGo);
      flyEl.removeEventListener('click', onFly);
      clearEl.removeEventListener('click', onClear);
      swapEl.removeEventListener('click', onSwap);
      collapseEl.removeEventListener('click', onCollapse);
      startEl.removeEventListener('keydown', onEnter);
      destEl.removeEventListener('keydown', onEnter);
      root.remove();
    },
  };
}
