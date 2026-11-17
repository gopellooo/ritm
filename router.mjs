const ENDPOINT = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/';
const radians = Math.PI / 180;
let lastRequest = -Infinity;

function offset([lon, lat], bearing, distance) {
  const angle = bearing * radians;
  const arc = distance / 6371;
  const fromLat = lat * radians;
  const toLat = Math.asin(Math.sin(fromLat) * Math.cos(arc) + Math.cos(fromLat) * Math.sin(arc) * Math.cos(angle));
  const toLon = lon + Math.atan2(Math.sin(angle) * Math.sin(arc) * Math.cos(fromLat), Math.cos(arc) - Math.sin(fromLat) * Math.sin(toLat)) / radians;
  return [((toLon + 540) % 360) - 180, Math.max(-85, Math.min(85, toLat / radians))];
}

function waypoints(start, km, mode, heading) {
  if (mode === 'back') return [start, offset(start, heading, km * .42), start];
  return [start, offset(start, heading - 48, km * .18), offset(start, heading, km * .31), offset(start, heading + 48, km * .18), start];
}

function overlap(coordinates) {
  const edges = new Set();
  let length = 0;
  let repeated = 0;
  for (let index = 1; index < coordinates.length; index++) {
    const [a, b] = coordinates.slice(index - 1, index + 1);
    const edge = [a, b].map(point => point.map(value => value.toFixed(5)).join(',')).sort().join(';');
    const segment = Math.hypot((b[0] - a[0]) * Math.cos(a[1] * radians), b[1] - a[1]);
    length += segment;
    if (edges.has(edge)) repeated += segment;
    edges.add(edge);
  }
  return length ? repeated / length : 1;
}

async function directions(points, signal, snapRadius) {
  const delay = Math.max(0, 1100 - (performance.now() - lastRequest));
  if (delay) await new Promise(resolve => setTimeout(resolve, delay));
  signal.throwIfAborted();
  lastRequest = performance.now();

  const coordinates = points.map(point => point.map(value => value.toFixed(6)).join(',')).join(';');
  const radiuses = points.map((_, i) => Array.isArray(snapRadius) ? snapRadius[i] : snapRadius ?? (i === 0 || i === points.length - 1 ? 120 : 260)).join(';');
  const url = `${ENDPOINT}${coordinates}?overview=full&geometries=geojson&generate_hints=false&radiuses=${radiuses}`;
  let response;
  let data;
  try {
    response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(9000)]) });
    data = await response.json();
  } catch {
    signal.throwIfAborted();
    throw new Error('Сервис маршрутов не ответил. Попробуй ещё раз чуть позже.');
  }
  if (data.code === 'NoSegment' || data.code === 'NoRoute') return null;
  const route = data.routes?.[0];
  if (!response.ok || data.code !== 'Ok' || !route?.geometry?.coordinates?.length) {
    throw new Error('Сервис маршрутов временно недоступен. Попробуй ещё раз чуть позже.');
  }
  return {
    coordinates: route.geometry.coordinates,
    km: route.distance / 1000,
    waypoints: data.waypoints?.map(point => point.location)
  };
}

export async function planRun({ start, km, mode, heading, signal, maxKm }) {
  const target = Math.min(km, maxKm * .98);
  let best;
  let scale = 1;
  for (const turn of [0, 117, 241]) {
    let route;
    try {
      route = await directions(waypoints(start, target * scale, mode, heading + turn), signal);
    } catch (error) {
      if (best && !signal.aborted) return best.route;
      throw error;
    }
    if (!route || route.km <= 0) continue;

    scale = Math.max(.6, Math.min(1.5, scale * target / route.km));
    if (route.km > maxKm) continue;

    const error = Math.abs(route.km / km - 1);
    const repeat = mode === 'loop' ? overlap(route.coordinates) : 0;
    const score = error + repeat * .7;
    if (!best || score < best.score) best = { route, score };
    if (error <= .085 && repeat < .2) break;
  }
  if (best) return best.route;
  throw new Error('Рядом не нашлось подходящего пути. Перенеси старт ближе к пешеходной дорожке или измени дистанцию.');
}

export async function planThroughPoints({ points, signal, maxKm }) {
  if (points.length < 2 || points.length > 10) throw new Error('Выбери от 2 до 10 точек.');
  const route = await directions(points, signal, 35);
  if (!route || !(route.km > 0) || route.waypoints?.length !== points.length) {
    throw new Error('Не удалось проложить пешеходный маршрут через все точки. Попробуй перенести отметки ближе к дорожкам.');
  }
  if (route.km > maxKm) {
    throw new Error(`Маршрут через эти точки длиннее ${maxKm} км. Выбери точки ближе друг к другу.`);
  }
  return route;
}

export async function planPointsDistance({ points, km, heading, signal, maxKm }) {
  if (points.length < 2 || points.length > 3) throw new Error('Для заданной дистанции выбери 2 или 3 точки.');
  const base = await planThroughPoints({ points, signal, maxKm });
  const tolerance = Math.max(.1, km * .085);
  if (base.km > km + tolerance) {
    throw new Error(`Кратчайший путь через эти точки — ${base.km.toFixed(1).replace('.', ',')} км. Увеличь дистанцию или перенеси точки ближе.`);
  }
  if (Math.abs(base.km - km) <= tolerance) return base;

  const extra = km - base.km;
  const targetExtra = Math.min(km, maxKm * .98) - base.km;
  let scale = 1;
  let best;
  for (const turn of [0, 117, 241, 63]) {
    const loop = waypoints(points[0], targetExtra * scale, 'loop', heading + turn);
    const stops = [...loop, ...points.slice(1)];
    const radiuses = stops.map((_, index) => index > 0 && index < 4 ? 260 : 35);
    const candidate = await directions(stops, signal, radiuses);
    if (!candidate || candidate.waypoints?.length !== stops.length) continue;

    const added = candidate.km - base.km;
    if (added > 0) scale = Math.max(.3, Math.min(2.5, scale * extra / added));
    if (candidate.km > maxKm) continue;
    const error = Math.abs(candidate.km - km);
    if (!best || error < best.error) {
      best = { error, route: { ...candidate, waypoints: [candidate.waypoints[0], ...candidate.waypoints.slice(5)] } };
    }
    if (error <= tolerance) return best.route;
  }
  if (best?.error <= tolerance) return best.route;
  throw new Error(`Не удалось подобрать маршрут на ${km.toFixed(1).replace('.', ',')} км через эти точки. Попробуй другую дистанцию или расположение точек.`);
}

export function makeGpx(coordinates) {
  const track = coordinates.map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"/>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Ритм" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>Пробежка · Ритм</name><trkseg>\n${track}\n  </trkseg></trk>\n</gpx>\n`;
}
