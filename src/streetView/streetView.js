import * as Cesium from 'cesium';

const GMAPS_CALLBACK = '__gevGoogleMapsReady';
let gmapsPromise = null;

/** Load the Google Maps JS API once; resolves when `google.maps` is ready. */
function loadGoogleMaps(apiKey) {
  if (window.google?.maps) return Promise.resolve();
  if (gmapsPromise) return gmapsPromise;
  gmapsPromise = new Promise((resolve, reject) => {
    window[GMAPS_CALLBACK] = () => resolve();
    const script = document.createElement('script');
    script.async = true;
    script.src =
      'https://maps.googleapis.com/maps/api/js' +
      `?key=${encodeURIComponent(apiKey)}&v=weekly&loading=async&callback=${GMAPS_CALLBACK}`;
    script.onerror = () => {
      gmapsPromise = null;
      reject(
        new Error('Could not load Google Maps. Check the key and network.'),
      );
    };
    document.head.appendChild(script);
  });
  return gmapsPromise;
}

/** Degrees at the camera's screen-centre ground point, or null if it misses the globe. */
function cameraCenterLatLon(viewer) {
  const { scene, camera } = viewer;
  const canvas = scene.canvas;
  const center = new Cesium.Cartesian2(
    canvas.clientWidth / 2,
    canvas.clientHeight / 2,
  );
  let cartesian;
  try {
    cartesian = scene.pickPosition?.(center);
  } catch {
    cartesian = undefined;
  }
  if (!Cesium.defined(cartesian))
    cartesian = camera.pickEllipsoid(center, Cesium.Ellipsoid.WGS84);
  if (!Cesium.defined(cartesian)) return null;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    lat: Cesium.Math.toDegrees(carto.latitude),
    lon: Cesium.Math.toDegrees(carto.longitude),
  };
}

/**
 * Ground-level Google Street View overlay. A floating control (and Alt-click on
 * the globe) opens a walkable panorama at the chosen point; Esc or Exit closes.
 */
export function createStreetView({
  viewer,
  getApiKey = () => window.__GOOGLE_MAPS_API_KEY__,
  doc = document,
}) {
  let panorama = null;
  let open = false;
  let clickHandler = null;

  const root = doc.createElement('div');
  root.id = 'gev-street-view';
  root.hidden = true;
  root.innerHTML = `
    <div class="gev-sv-pano"></div>
    <div class="gev-sv-bar">
      <span class="gev-sv-title">STREET VIEW</span>
      <span class="gev-sv-coords"></span>
      <button class="gev-sv-exit" type="button">EXIT · ESC</button>
    </div>
    <div class="gev-sv-toast" hidden></div>
  `;
  doc.body.appendChild(root);
  const panoEl = root.querySelector('.gev-sv-pano');
  const coordsEl = root.querySelector('.gev-sv-coords');
  const toastEl = root.querySelector('.gev-sv-toast');

  const button = doc.createElement('button');
  button.id = 'gev-street-view-btn';
  button.type = 'button';
  button.title =
    'Drop into Street View at the map centre (Alt-click the globe for a point)';
  button.innerHTML =
    '<span class="gev-sv-icon">🚶</span><span>STREET VIEW</span>';
  doc.body.appendChild(button);

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.hidden = true), 3200);
  }

  function show() {
    open = true;
    root.hidden = false;
    doc.addEventListener('keydown', onKey, true);
  }

  function close() {
    if (!open) return;
    open = false;
    root.hidden = true;
    if (panorama) panorama.setVisible(false);
    doc.removeEventListener('keydown', onKey, true);
  }

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
    }
  }

  async function openAt(lat, lon) {
    const apiKey = getApiKey();
    if (!apiKey) {
      toast('Add a Google Maps key in POWER UP to use Street View.');
      return;
    }
    toast('Loading Street View…');
    try {
      await loadGoogleMaps(apiKey);
    } catch (error) {
      toast(error.message);
      return;
    }
    const service = new window.google.maps.StreetViewService();
    service.getPanorama(
      {
        location: { lat, lng: lon },
        radius: 80,
        source: window.google.maps.StreetViewSource.OUTDOOR,
      },
      (data, status) => {
        if (status !== 'OK' || !data?.location) {
          toast('No Street View imagery near that spot.');
          return;
        }
        if (!panorama) {
          panorama = new window.google.maps.StreetViewPanorama(panoEl, {
            addressControl: true,
            fullscreenControl: false,
            motionTracking: false,
            motionTrackingControl: false,
          });
        }
        panorama.setPano(data.location.pano);
        panorama.setPov({ heading: 0, pitch: 0 });
        panorama.setVisible(true);
        const desc =
          data.location.description || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        coordsEl.textContent = desc;
        toastEl.hidden = true;
        show();
      },
    );
  }

  function openFromCamera() {
    const center = cameraCenterLatLon(viewer);
    if (!center) {
      toast('Point the camera at the ground first, then try Street View.');
      return;
    }
    void openAt(center.lat, center.lon);
  }

  // Alt-click a point on the globe to enter Street View there.
  clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clickHandler.setInputAction(
    (movement) => {
      let cartesian;
      try {
        cartesian = viewer.scene.pickPosition?.(movement.position);
      } catch {
        cartesian = undefined;
      }
      if (!Cesium.defined(cartesian))
        cartesian = viewer.camera.pickEllipsoid(
          movement.position,
          Cesium.Ellipsoid.WGS84,
        );
      if (!Cesium.defined(cartesian)) return;
      const carto = Cesium.Cartographic.fromCartesian(cartesian);
      void openAt(
        Cesium.Math.toDegrees(carto.latitude),
        Cesium.Math.toDegrees(carto.longitude),
      );
    },
    Cesium.ScreenSpaceEventType.LEFT_CLICK,
    Cesium.KeyboardEventModifier.ALT,
  );

  const onButton = () => openFromCamera();
  const onExit = () => close();
  button.addEventListener('click', onButton);
  root.querySelector('.gev-sv-exit').addEventListener('click', onExit);

  return {
    button,
    openFromCamera,
    openAt,
    close,
    destroy() {
      close();
      clickHandler?.destroy();
      button.removeEventListener('click', onButton);
      button.remove();
      root.remove();
    },
  };
}
