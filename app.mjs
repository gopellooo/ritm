import { makeGpx, planRun, planThroughPoints } from './router.mjs?v=3';

const $ = id => document.getElementById(id);
const demoStart = [37.59943, 55.73106];
const number = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const form = $('planner-form');
const distance = $('distance');
const pointList = $('point-list');
const mapPanel = $('map').parentElement;
const maplibre = window.maplibregl;
const points = [];
const pointMarkers = [];
const routeLabels = {
  loop: ['Кольцевой маршрут', '#i-loop'],
  back: ['Маршрут туда-обратно', '#i-back'],
  points: ['Маршрут по точкам', '#i-points']
};
let start = demoStart;
let startCaption = 'Москва · Парк Горького';
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

function isPointsMode() {
  return form.elements.mode.value === 'points';
}

function mapCoordinates(lngLat) {
  const { lng, lat } = lngLat.wrap();
  return [lng, Math.max(-85, Math.min(85, lat))];
}

function coordinatesLabel([lon, lat]) {
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

function drawPoints(active) {
  for (const waypoint of pointMarkers.splice(0)) waypoint.remove();
  if (!active) return;

  pointList.replaceChildren();
  pointList.hidden = points.length === 0;
  const returnToStart = form.elements.finish.value === 'start';
  const hints = [
    returnToStart ? 'Отметь старт и 1–2 точки, через которые пройдёт маршрут.' : 'Отметь старт и финиш. Точка между ними необязательна.',
    returnToStart ? 'Добавь точку, через которую пройдёт маршрут.' : 'Добавь финиш или промежуточную точку.',
    'Построй маршрут или добавь третью точку.',
    'Можно построить маршрут. Чтобы заменить точку, сначала удали её из списка.'
  ];
  $('points-help').textContent = hints[points.length];

  points.forEach((point, index) => {
    const item = document.createElement('li');
    const badge = document.createElement('span');
    badge.className = 'point-badge';
    badge.textContent = String(index + 1);
    badge.setAttribute('aria-hidden', 'true');

    const description = document.createElement('span');
    description.className = 'point-description';
    if (index === 0) {
      description.textContent = returnToStart ? 'Старт и финиш' : 'Старт';
    } else {
      description.textContent = !returnToStart && index === points.length - 1 ? 'Финиш' : 'Промежуточная точка';
    }
    const coords = document.createElement('small');
    coords.textContent = coordinatesLabel(point);
    description.append(coords);

    const remove = document.createElement('button');
    remove.className = 'remove-point';
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Удалить точку ${index + 1}`);
    remove.addEventListener('click', () => {
      points.splice(index, 1);
      invalidate();
      const next = pointList.querySelectorAll('button')[Math.min(index, points.length - 1)];
      (next ?? $('choose-center')).focus();
    });
    item.append(badge, description, remove);
    pointList.append(item);

    if (map) {
      const element = badge.cloneNode(true);
      element.classList.add('point-marker');
      pointMarkers.push(new maplibre.Marker({ element }).setLngLat(route?.waypoints?.[index] ?? point).addTo(map));
    }
  });
}

function updateMapOverlays(pointMode) {
  $('map-picker').hidden = !map || !(picking || (pointMode && !route && points.length < 3));
  $('center-label').textContent = pointMode ? 'Добавить точку в центре' : 'Старт в центре карты';
  $('result').hidden = picking || !route;
}

function redraw() {
  const pointMode = isPointsMode();
  const coordinates = route?.coordinates;
  const features = coordinates ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : [];
  map?.getSource('run')?.setData({ type: 'FeatureCollection', features });
  if (marker) {
    marker.getElement().hidden = pointMode;
    marker.setLngLat(!pointMode && coordinates ? coordinates[0] : start);
  }
  drawPoints(pointMode);
  updateMapOverlays(pointMode);
  $('map-location').textContent = pointMode ? `Точки маршрута · ${points.length} из 3` : startCaption;
  if (route) {
    const [label, icon] = route.returnToStart ? ['Круг по точкам', '#i-loop'] : routeLabels[route.mode];
    $('actual-km').textContent = number.format(route.km);
    $('result-type').textContent = route.demo ? 'Пример кольцевого маршрута' : label;
    $('result-icon').firstElementChild.setAttribute('href', icon);
  }
  $('reroute').hidden = pointMode;
  $('fit').disabled = pointMode && points.length === 0;
  $('fit').setAttribute('aria-label', route ? 'Показать весь маршрут' : pointMode ? 'Показать выбранные точки' : 'Показать точку старта');
  $('fit').title = $('fit').getAttribute('aria-label');
}

function fitRoute() {
  if (!map) return;
  const coordinates = route?.coordinates ?? (isPointsMode() ? points : [start]);
  if (coordinates.length === 0) return;
  if (coordinates.length === 1) {
    map.easeTo({ center: coordinates[0], zoom: Math.max(map.getZoom(), 13), duration: 450 });
    return;
  }
  const bounds = new maplibre.LngLatBounds();
  const reference = coordinates[0][0];
  for (const [lon, lat] of coordinates) {
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
  updateMapOverlays(isPointsMode());
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
  start = mapCoordinates(lngLat);
  ++startVersion;
  heading = Math.floor(Math.random() * 360);
  const coordinates = coordinatesLabel(start);
  $('start-name').textContent = label || coordinates;
  startCaption = label || `Старт · ${coordinates}`;
  setPicking(false);
  invalidate();
  if (focus) fitRoute();
}

function selectMapPoint(lngLat) {
  if (!isPointsMode()) {
    chooseStart(lngLat);
    return;
  }
  if (points.length === 3) {
    status('Уже выбрано 3 точки. Удали одну из них, чтобы добавить новую.', true);
    return;
  }
  points.push(mapCoordinates(lngLat));
  invalidate();
}

function updateModeFields() {
  const pointMode = isPointsMode();
  $('start-field').hidden = pointMode;
  $('distance-field').hidden = pointMode;
  $('finish-field').hidden = !pointMode;
  $('points-field').hidden = !pointMode;
  distance.disabled = pointMode;
  setPicking(false);
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
  map.on('click', event => selectMapPoint(event.lngLat));
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
  const pointMode = isPointsMode();
  if (pointMode && points.length < 2) {
    status('Отметь на карте хотя бы 2 точки.', true);
    return;
  }
  const controller = new AbortController();
  const { signal } = controller;
  request = controller;
  const km = Number(distance.value);
  const mode = form.elements.mode.value;
  const maxKm = Number(distance.max);
  const returnToStart = form.elements.finish.value === 'start';
  if (another) heading += 57;
  const previousRoute = route;
  setPicking(false);
  busy(true);
  status('Подбираем путь по пешеходным дорожкам…');
  try {
    const result = pointMode
      ? await planThroughPoints({ points: [...points], signal, maxKm, returnToStart })
      : await planRun({ start, km, mode, heading, signal, maxKm });
    signal.throwIfAborted();
    route = { ...result, mode, returnToStart: pointMode && returnToStart };
    redraw();
    fitRoute();
    const difference = Math.abs(result.km - km);
    if (another && JSON.stringify(result.coordinates) === JSON.stringify(previousRoute?.coordinates)) {
      status('По этому старту получился тот же путь. Попробуй изменить старт или дистанцию.');
    } else {
      status(!pointMode && difference / km > .15 ? `Ближайший из найденных вариантов — ${number.format(result.km)} км.` : `Маршрут готов · ${number.format(result.km)} км`);
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
document.querySelectorAll('[name="mode"]').forEach(input => input.addEventListener('change', () => {
  ++startVersion;
  updateModeFields();
  invalidate();
}));
document.querySelectorAll('[name="finish"]').forEach(input => input.addEventListener('change', invalidate));
$('pick-start').addEventListener('click', () => {
  if (!map) { status('Карта недоступна. Обнови страницу.', true); return; }
  setPicking(!picking);
  if (picking && matchMedia('(max-width: 720px)').matches) mapPanel.scrollIntoView({ block: 'start' });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && picking) setPicking(false);
});
$('choose-center').addEventListener('click', () => selectMapPoint(map.getCenter()));
$('locate').addEventListener('click', locate);
$('zoom-in').addEventListener('click', () => map.zoomIn());
$('zoom-out').addEventListener('click', () => map.zoomOut());
$('fit').addEventListener('click', fitRoute);
$('download').addEventListener('click', download);
$('reroute').addEventListener('click', () => void buildRoute(true));
$('about-open').addEventListener('click', () => $('about').showModal());

updateModeFields();
initMap();
redraw();
fetch('./demo.json').then(response => response.ok ? response.json() : null).then(demo => {
  if (!demo || form.elements.mode.value !== 'loop' || inputVersion || request || route) return;
  route = { ...demo, mode: 'loop', demo: true };
  redraw();
  if (map?.getSource('run')) fitRoute();
}).catch(() => {});
