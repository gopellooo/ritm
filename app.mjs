import { makeGpx, planRun } from './router.mjs';

const $ = id => document.getElementById(id);
const demoStart = [37.59943, 55.73106];
const number = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const form = $('planner-form');
const distance = $('distance');
const mapPanel = $('map').parentElement;
const maplibre = window.maplibregl;
let start = demoStart;
let heading = 196;
let route;
let request;
let map;
let marker;
let picking = false;
let startVersion = 0;
let inputVersion = 0;

function status(message = '', error = false) {
  $('form-status').textContent = message;
  $('form-status').dataset.error = String(error);
}

function redraw() {
  const coordinates = route?.coordinates;
  const features = coordinates ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : [];
  map?.getSource('run')?.setData({ type: 'FeatureCollection', features });
  marker?.setLngLat(coordinates ? coordinates[0] : start);
  $('result').hidden = picking || !route;
  if (route) {
    $('actual-km').textContent = number.format(route.km);
    $('result-type').textContent = route.demo ? 'Пример кольцевого маршрута' : route.mode === 'loop' ? 'Кольцевой маршрут' : 'Маршрут туда-обратно';
    $('result-icon').firstElementChild.setAttribute('href', route.mode === 'loop' ? '#i-loop' : '#i-back');
  }
  $('fit').setAttribute('aria-label', route ? 'Показать весь маршрут' : 'Показать точку старта');
  $('fit').title = $('fit').getAttribute('aria-label');
}

function fitRoute() {
  if (!map) return;
  if (!route) {
    map.easeTo({ center: start, zoom: Math.max(map.getZoom(), 13), duration: 450 });
    return;
  }
  const bounds = new maplibre.LngLatBounds();
  const reference = route.coordinates[0][0];
  for (const [lon, lat] of route.coordinates) {
    bounds.extend([reference + (((lon - reference + 540) % 360) - 180), lat]);
  }
  map.fitBounds(bounds, {
    padding: { top: 68, left: 54, right: 68, bottom: mapPanel.clientHeight < 500 ? 136 : 151 },
    maxZoom: 16,
    duration: 600
  });
}

function setPicking(next) {
  picking = next;
  $('pick-start').setAttribute('aria-pressed', String(next));
  $('map-picker').hidden = !next;
  $('result').hidden = next || !route;
  $('start-help').textContent = next ? 'Отметь точку на карте или выбери её центр.' : 'Нажми на карту, чтобы изменить старт.';
}

function busy(next) {
  $('build').disabled = next;
  $('reroute').disabled = next;
  $('build-label').textContent = next ? 'Строим маршрут…' : 'Построить маршрут';
}

function invalidate() {
  ++inputVersion;
  request?.abort();
  request = null;
  route = null;
  busy(false);
  status();
  redraw();
}

function chooseStart(lngLat, label, focus = false) {
  const { lng, lat } = lngLat.wrap();
  start = [lng, Math.max(-85, Math.min(85, lat))];
  ++startVersion;
  heading = Math.floor(Math.random() * 360);
  const coordinates = `${start[1].toFixed(5)}, ${start[0].toFixed(5)}`;
  $('start-name').textContent = label || coordinates;
  $('map-location').textContent = label || `Старт · ${coordinates}`;
  setPicking(false);
  invalidate();
  if (focus) fitRoute();
}

function mapMessage(message) {
  $('map-message').textContent = message;
  $('map-message').hidden = !message;
}

function initMap() {
  try {
    map = new maplibre.Map({
      container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty', center: [-.01 + start[0], -.006 + start[1]], zoom: 13.6,
      minZoom: 2, maxZoom: 19, maxPitch: 0, dragRotate: false, pitchWithRotate: false, locale: {
        'AttributionControl.ToggleAttribution': 'Источники карты', 'Map.Title': 'Карта, выбери старт'
      }
    });
  } catch {
    mapMessage('Карта недоступна. Проверь подключение и поддержку WebGL в браузере.');
    return;
  }
  map.addControl(new maplibre.ScaleControl({ unit: 'metric' }), 'bottom-right');
  map.touchZoomRotate.disableRotation();
  const element = document.createElement('div');
  element.className = 'start-marker';
  element.setAttribute('aria-hidden', 'true');
  marker = new maplibre.Marker({ element }).setLngLat(start).addTo(map);
  $('map-tools').hidden = false;
  map.on('click', event => chooseStart(event.lngLat));
  map.on('error', () => {
    if (!map.getSource('run')) mapMessage('Карта загружается. Если она не появится, обнови страницу.');
  });
  map.once('load', () => {
    mapMessage('');
    map.addSource('run', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const paint = { 'line-color': '#304e30', 'line-width': 9 };
    const layout = { 'line-cap': 'round', 'line-join': 'round' };
    map.addLayer({ id: 'run-outline', source: 'run', type: 'line', paint, layout });
    map.addLayer({ id: 'run-line', source: 'run', type: 'line', paint: { 'line-color': '#cbf353', 'line-width': 5.5 }, layout });
    redraw();
    if (route) fitRoute();
  });
}

async function buildRoute(another = false) {
  if (request || !form.reportValidity()) return;
  const controller = new AbortController();
  const { signal } = controller;
  request = controller;
  const km = Number(distance.value);
  const mode = new FormData(form).get('mode');
  if (another) heading += 57;
  const previousRoute = route;
  setPicking(false);
  busy(true);
  status('Подбираем путь по пешеходным дорожкам…');
  try {
    const result = await planRun({ start, km, mode, heading, signal });
    signal.throwIfAborted();
    route = { ...result, mode };
    redraw();
    fitRoute();
    const difference = Math.abs(result.km - km);
    if (another && JSON.stringify(result.coordinates) === JSON.stringify(previousRoute?.coordinates)) {
      status('По этому старту получился тот же путь. Попробуй изменить старт или дистанцию.');
    } else {
      status(difference / km > .15 ? `Ближайший из найденных вариантов — ${number.format(result.km)} км.` : `Маршрут готов · ${number.format(result.km)} км`);
    }
    if (matchMedia('(max-width: 720px)').matches) mapPanel.scrollIntoView({ block: 'start' });
  } catch (error) {
    if (!signal.aborted) status(error.message, true);
  } finally {
    if (request === controller) {
      request = null;
      busy(false);
    }
  }
}

function updateDistance() {
  document.querySelectorAll('[data-km]').forEach(button => {
    button.setAttribute('aria-pressed', String(Number(button.dataset.km) === Number(distance.value)));
  });
  invalidate();
}

function locate() {
  if (!map || !navigator.geolocation) {
    status('Геолокация недоступна. Выбери старт на карте.', true);
    return;
  }
  const version = ++startVersion;
  $('locate').disabled = true;
  status('Определяем местоположение…');
  navigator.geolocation.getCurrentPosition(({ coords }) => {
    $('locate').disabled = false;
    if (version === startVersion) chooseStart(new maplibre.LngLat(coords.longitude, coords.latitude), 'Моё местоположение', true);
  }, () => {
    $('locate').disabled = false;
    if (version === startVersion) status('Не удалось определить местоположение. Выбери старт на карте.', true);
  }, { timeout: 8000, maximumAge: 60000 });
}

function download() {
  if (!route) return;
  const gpx = new Blob([makeGpx(route.coordinates)], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(gpx);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ritm-route.gpx';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

form.addEventListener('submit', event => {
  event.preventDefault();
  void buildRoute();
});
distance.addEventListener('input', updateDistance);
document.querySelectorAll('[data-km]').forEach(button => button.addEventListener('click', () => {
  if (distance.value === button.dataset.km) return;
  distance.value = button.dataset.km;
  updateDistance();
}));
document.querySelectorAll('[name="mode"]').forEach(input => input.addEventListener('change', invalidate));
$('pick-start').addEventListener('click', () => {
  if (!map) { status('Карта недоступна. Обнови страницу.', true); return; }
  setPicking(!picking);
  if (picking && matchMedia('(max-width: 720px)').matches) mapPanel.scrollIntoView({ block: 'start' });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && picking) setPicking(false);
});
$('choose-center').addEventListener('click', () => chooseStart(map.getCenter()));
$('locate').addEventListener('click', locate);
$('zoom-in').addEventListener('click', () => map.zoomIn());
$('zoom-out').addEventListener('click', () => map.zoomOut());
$('fit').addEventListener('click', fitRoute);
$('download').addEventListener('click', download);
$('reroute').addEventListener('click', () => void buildRoute(true));
$('about-open').addEventListener('click', () => $('about').showModal());

initMap();
fetch('./demo.json').then(response => response.ok ? response.json() : null).then(demo => {
  if (!demo || inputVersion || request || route) return;
  route = { ...demo, mode: 'loop', demo: true };
  redraw();
  if (map?.getSource('run')) fitRoute();
}).catch(() => {});
