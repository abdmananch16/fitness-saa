'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  tracking:       false,
  steps:          0,
  distanceKm:     0,
  calories:       0,
  startTime:      null,
  timerHandle:    null,
  watchId:        null,
  lastPos:        null,   // {lat, lng}
  routePoints:    [],     // [{lat, lng}]
  stepGoal:       10000,

  // Accelerometer
  accelReady:     false,
  accelBuf:       [],     // rolling magnitude buffer
  lastPeak:       false,
  lastStepAt:     0,
  STEP_THRESH:    1.15,   // tune if needed
  MIN_STEP_MS:    280,
};

// ─────────────────────────────────────────────────────────────────────────────
//  MAP  (Leaflet + OpenStreetMap — 100% free, no API key)
// ─────────────────────────────────────────────────────────────────────────────
let map, routeLine, userDot, startDot;

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: false });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(map);

  routeLine = L.polyline([], {
    color: '#58a6ff',
    weight: 4,
    opacity: 0.85,
  }).addTo(map);

  // Try to show current location on load
  navigator.geolocation?.getCurrentPosition(
    (p) => map.setView([p.coords.latitude, p.coords.longitude], 17),
    ()  => map.setView([0, 0], 2)
  );
}

function mapAddPoint(lat, lng) {
  if (!map) return;

  const ll = [lat, lng];
  routeLine.addLatLng(ll);

  // Start dot (green) — placed once
  if (S.routePoints.length === 1) {
    startDot = L.circleMarker(ll, {
      radius: 7, color: '#fff', weight: 2,
      fillColor: '#3fb950', fillOpacity: 1,
    }).addTo(map);
  }

  // User dot (blue) — moves with user
  if (!userDot) {
    userDot = L.circleMarker(ll, {
      radius: 9, color: '#fff', weight: 2,
      fillColor: '#58a6ff', fillOpacity: 1,
    }).addTo(map);
  } else {
    userDot.setLatLng(ll);
  }

  map.panTo(ll);
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
function startTracking() {
  if (S.tracking) return;
  S.tracking   = true;
  S.startTime  = Date.now();

  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled  = false;
  document.body.classList.add('tracking');

  setStatus('Tracking…');
  startTimer();
  startGPS();
  startAccel();
}

function stopTracking() {
  if (!S.tracking) return;
  S.tracking = false;

  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled  = true;
  document.body.classList.remove('tracking');

  stopTimer();
  stopGPS();
  stopAccel();
  setStatus('Stopped — ' + fmtDuration(Date.now() - S.startTime));
}

function resetTracking() {
  stopTracking();

  S.steps = 0; S.distanceKm = 0; S.calories = 0;
  S.routePoints = []; S.lastPos = null;
  S.accelBuf = []; S.lastPeak = false;

  if (routeLine) routeLine.setLatLngs([]);
  if (userDot)   { userDot.remove();   userDot   = null; }
  if (startDot)  { startDot.remove();  startDot  = null; }

  document.getElementById('duration').textContent  = '00:00';
  document.getElementById('avg-pace').textContent  = '—';
  document.getElementById('gps-acc').textContent   = '—';
  document.getElementById('route-pts').textContent = '0';
  document.getElementById('speed').textContent     = '0.0';
  document.getElementById('sensor-status').textContent = '—';

  setStatus('Ready — press Start to begin');
  setBadge(false);
  renderUI();
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIMER
// ─────────────────────────────────────────────────────────────────────────────
function startTimer() {
  S.timerHandle = setInterval(() => {
    const ms = Date.now() - S.startTime;
    document.getElementById('duration').textContent = fmtDuration(ms);
    updatePace(ms);
  }, 1000);
}
function stopTimer() { clearInterval(S.timerHandle); S.timerHandle = null; }

function fmtDuration(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0
    ? `${pad(h)}:${pad(m)}:${pad(s)}`
    : `${pad(m)}:${pad(s)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

// ─────────────────────────────────────────────────────────────────────────────
//  GPS
// ─────────────────────────────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) {
    setStatus('GPS not available on this device');
    return;
  }
  S.watchId = navigator.geolocation.watchPosition(onGPS, onGPSErr, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  });
}

function stopGPS() {
  if (S.watchId != null) {
    navigator.geolocation.clearWatch(S.watchId);
    S.watchId = null;
  }
  setBadge(false);
}

function onGPS(pos) {
  const { latitude: lat, longitude: lng, accuracy, speed } = pos.coords;

  // Show map, hide placeholder
  document.getElementById('map-placeholder').classList.add('hidden');
  setBadge(true);

  document.getElementById('gps-acc').textContent =
    accuracy ? `±${Math.round(accuracy)} m` : '—';

  const kmh = speed != null ? (speed * 3.6).toFixed(1) : null;
  document.getElementById('speed').textContent = kmh ?? '—';

  if (!S.tracking) return;

  // Distance accumulation
  if (S.lastPos) {
    const d = haversine(S.lastPos.lat, S.lastPos.lng, lat, lng);
    // Accept segments between 2 m and 60 m (filters GPS noise & teleports)
    if (d >= 0.002 && d <= 0.06) {
      S.distanceKm += d;
      // GPS step fallback when no accelerometer
      if (!S.accelReady) {
        S.steps += Math.round(d * 1000 / 0.762);
      }
    }
  }

  S.lastPos = { lat, lng };
  S.routePoints.push({ lat, lng });
  document.getElementById('route-pts').textContent = S.routePoints.length;

  mapAddPoint(lat, lng);

  S.calories = calcCalories(S.distanceKm, S.steps);
  renderUI();
}

function onGPSErr(e) {
  const msg = {
    1: 'Location permission denied — please allow GPS access.',
    2: 'GPS signal unavailable.',
    3: 'GPS timed out.',
  };
  setStatus(msg[e.code] ?? 'GPS error');
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACCELEROMETER  (DeviceMotion API)
// ─────────────────────────────────────────────────────────────────────────────
function startAccel() {
  if (!window.DeviceMotionEvent) {
    document.getElementById('sensor-status').textContent = 'Not supported';
    return;
  }
  // iOS 13+ needs explicit permission
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
      .then(r => r === 'granted' ? attachAccel() : noAccel('Permission denied'))
      .catch(() => noAccel('Permission error'));
  } else {
    attachAccel();
  }
}

function attachAccel() {
  S.accelReady = true;
  document.getElementById('sensor-status').textContent = 'Accelerometer active';
  window.addEventListener('devicemotion', onMotion);
}

function noAccel(reason) {
  document.getElementById('sensor-status').textContent = reason + ' (GPS mode)';
}

function stopAccel() {
  window.removeEventListener('devicemotion', onMotion);
  S.accelReady = false;
  document.getElementById('sensor-status').textContent = '—';
}

function onMotion(e) {
  if (!S.tracking) return;
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;

  const mag = Math.sqrt(a.x ** 2 + a.y ** 2 + a.z ** 2);

  S.accelBuf.push(mag);
  if (S.accelBuf.length > 25) S.accelBuf.shift();
  if (S.accelBuf.length < 6) return;

  const avg   = S.accelBuf.reduce((s, v) => s + v, 0) / S.accelBuf.length;
  const delta = mag - avg;
  const now   = Date.now();

  if (delta > S.STEP_THRESH && !S.lastPeak) {
    if (now - S.lastStepAt > S.MIN_STEP_MS) {
      S.steps++;
      S.lastStepAt = now;
      S.calories   = calcCalories(S.distanceKm, S.steps);
      renderUI();
    }
    S.lastPeak = true;
  } else if (delta < 0) {
    S.lastPeak = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  UI RENDER
// ─────────────────────────────────────────────────────────────────────────────
function renderUI() {
  document.getElementById('step-count').textContent = S.steps.toLocaleString();
  document.getElementById('distance').textContent   = S.distanceKm.toFixed(2);
  document.getElementById('calories').textContent   = Math.round(S.calories);

  const pct = Math.min((S.steps / S.stepGoal) * 100, 100).toFixed(1);
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('goal-text').textContent =
    `${S.steps.toLocaleString()} / ${S.stepGoal.toLocaleString()}`;
  document.getElementById('goal-pct').textContent = pct + '%';
}

function updatePace(ms) {
  if (S.distanceKm < 0.01) return;
  const minPerKm  = (ms / 60000) / S.distanceKm;
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  document.getElementById('avg-pace').textContent = `${m}:${pad(s)} /km`;
}

function setStatus(msg) {
  document.getElementById('status-msg').textContent = msg;
}

function setBadge(on) {
  const b = document.getElementById('gps-badge');
  b.textContent = on ? 'GPS On' : 'GPS Off';
  b.classList.toggle('on', on);
}

// ─────────────────────────────────────────────────────────────────────────────
//  MATH
// ─────────────────────────────────────────────────────────────────────────────

/** Haversine distance in km between two lat/lng points */
function haversine(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a    =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function rad(d) { return (d * Math.PI) / 180; }

/** Simple calorie estimate: ~0.04 kcal/step + ~60 kcal/km */
function calcCalories(km, steps) {
  return steps * 0.04 + km * 60;
}

// ─────────────────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initMap);
