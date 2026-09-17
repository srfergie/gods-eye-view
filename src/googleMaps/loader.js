const CALLBACK = '__gevGoogleMapsReady';
let loadPromise = null;
const requested = new Set();

/** Ensure the listed libraries are present on an already-loaded maps object. */
async function ensureLibraries(maps, libraries) {
  const need = libraries.filter((lib) => !maps[lib]);
  if (need.length && typeof maps.importLibrary === 'function')
    await Promise.all(need.map((lib) => maps.importLibrary(lib)));
  return maps;
}

/**
 * Load the Google Maps JS API once, optionally with extra libraries
 * (e.g. 'places'). Safe to call from several features: one script is injected
 * and later callers reuse it, importing any additional libraries they need.
 */
export function loadGoogleMaps(apiKey, { libraries = [] } = {}) {
  if (!apiKey) return Promise.reject(new Error('No Google Maps key'));
  if (window.google?.maps)
    return ensureLibraries(window.google.maps, libraries);
  if (loadPromise)
    return loadPromise.then((maps) => ensureLibraries(maps, libraries));

  libraries.forEach((lib) => requested.add(lib));
  loadPromise = new Promise((resolve, reject) => {
    window[CALLBACK] = () => resolve(window.google.maps);
    const script = document.createElement('script');
    script.async = true;
    const libs = [...requested];
    script.src =
      'https://maps.googleapis.com/maps/api/js' +
      `?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=${CALLBACK}` +
      (libs.length ? `&libraries=${libs.join(',')}` : '');
    script.onerror = () => {
      loadPromise = null;
      reject(
        new Error('Could not load Google Maps. Check the key and network.'),
      );
    };
    document.head.appendChild(script);
  });
  return loadPromise;
}
