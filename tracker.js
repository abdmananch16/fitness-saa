'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────────────────────────
const S = {
  tracking:    false,
  steps:       0,
  distanceKm:  0,
  calories:    0,
  startTime:   null,
  timerHandle: null,
  watchId:     null,
  lastPos:     null,
  routePoints: [],
  stepGoal:    10000,
  strideMeter: 0.762,

  // Accelerometer
  accelReady:  false,
  accelBuf:    [],
  lastPeak:    false,
  lastStepAt:  0,
  STEP_THRESH: 1.15,
  MIN_STEP_MS: 280,

  // Weekly mock data (last 6 days + today)
  weeklySteps: [4200, 7800, 5100, 9300, 6600, 8100, 0],
};

// ─────────────────────────────────────────────────────────────────────────────
//  MAP
// ─────────────────────────────────────────────────────────────────────────────
let map, routeLine, userDot, startDot;
let currentTileLayer = null;

const TILES = {
  dark:      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  street:    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  satellite: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
};

function initMap() {
  map = L.map('map', { zoomControl: true, attributionControl: false });

  currentTileLayer = L.tileLayer(TILES.dark, { maxZoom: 19 }).addTo(map);

  routeLine = L.polyline([], {
    color: '#818cf8', weight: 5, opacity: 0.9,
  }).addTo(map);

  navigator.geolocation?.getCurrentPosition(
    (p) => map.setView([p.coords.latitude, p.coords.longitude], 17),
    ()  => map.setView([20, 0], 2)
  );
}

function mapAddPoint(lat, lng) {
  if (!map) return;
  const ll = [lat, lng];
  routeLine.addLatLng(ll);

  if (S.routePoints.length === 1) {
    startDot = L.circleMarker(ll, {
      radius: 8, color: '#fff', weight: 2,
      fillColor: '#10b981', fillOpacity: 1,
    }).addTo(map).bindTooltip('Start', { permanent: false });
  }

  if (!userDot) {
    userDot = L.circleMarker(ll, {
      radius: 10, color: '#fff', weight: 2,
      fillColor: '#6366f1', fillOpacity: 1,
    }).addTo(map);
  } else {
    userDot.setLatLng(ll);
  }
  map.panTo(ll);
}

function setMapTheme(theme, btn) {
  if (!map) return;
  if (currentTileLayer) map.removeLayer(currentTileLayer);
  currentTileLayer = L.tileLayer(TILES[theme], { maxZoom: 19 }).addTo(map);
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

// ─────────────────────────────────────────────────────────────────────────────
//  NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  document.querySelector(`[data-page="${name}"]`).classList.add('active');
  document.getElementById('page-title').textContent =
    { dashboard: 'Dashboard', map: 'Live Map', stats: 'Stats', settings: 'Settings' }[name];

  // Invalidate map size when switching to map tab
  if (name === 'map' && map) setTimeout(() => map.invalidateSize(), 100);

  // Close sidebar on mobile
  document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

// ─────────────────────────────────────────────────────────────────────────────
//  TRACKING CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
function startTracking() {
  if (S.tracking) return;
  S.tracking  = true;
  S.startTime = Date.now();

  document.getElementById('btn-start').disabled = true;
  document.getElementById('btn-stop').disabled  = false;
  document.getElementById('status-dot').classList.add('active');
  document.getElementById('live-badge').classList.add('on');

  setStatus('Tracking your activity…');
  startTimer();
  startGPS();
  startAccel();
}

function stopTracking() {
  if (!S.tracking) return;
  S.tracking = false;

  document.getElementById('btn-start').disabled = false;
  document.getElementById('btn-stop').disabled  = true;
  document.getElementById('status-dot').classList.remove('active');
  document.getElementById('live-badge').classList.remove('on');

  stopTimer();
  stopGPS();
  stopAccel();
  setStatus('Session stopped — ' + fmtDuration(Date.now() - S.startTime));
}

function resetTracking() {
  stopTracking();

  S.steps = 0; S.distanceKm = 0; S.calories = 0;
  S.routePoints = []; S.lastPos = null;
  S.accelBuf = []; S.lastPeak = false;
  S.weeklySteps[6] = 0;

  if (routeLine) routeLine.setLatLngs([]);
  if (userDot)  { userDot.remove();  userDot  = null; }
  if (startDot) { startDot.remove(); startDot = null; }

  document.getElementById('h-duration').textContent = '00:00';
  document.getElementById('c-pace').textContent     = '—';
  document.getElementById('c-acc').textContent      = '—';
  document.getElementById('c-pts').textContent      = '0';
  document.getElementById('h-speed').textContent    = '0.0';

  setStatus('Ready — press Start to begin');
  setGPS(false);
  renderUI();
  renderChart();
}

// ─────────────────────────────────────────────────────────────────────────────
//  TIMER
// ─────────────────────────────────────────────────────────────────────────────
function startTimer() {
  S.timerHandle = setInterval(() => {
    const ms = Date.now() - S.startTime;
    const t  = fmtDuration(ms);
    document.getElementById('h-duration').textContent = t;
    document.getElementById('mo-time').textContent    = t;
    document.getElementById('ss-time').textContent    = t;
    updatePace(ms);
  }, 1000);
}
function stopTimer() { clearInterval(S.timerHandle); S.timerHandle = null; }

function fmtDuration(ms) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }

// ─────────────────────────────────────────────────────────────────────────────
//  GPS
// ─────────────────────────────────────────────────────────────────────────────
function startGPS() {
  if (!navigator.geolocation) { setStatus('GPS not available'); return; }
  S.watchId = navigator.geolocation.watchPosition(onGPS, onGPSErr, {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 15000,
  });
}
function stopGPS() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
  setGPS(false);
}

function onGPS(pos) {
  const { latitude: lat, longitude: lng, accuracy, speed } = pos.coords;

  document.getElementById('map-overlay').classList.add('hidden');
  setGPS(true);

  document.getElementById('c-acc').textContent =
    accuracy ? `±${Math.round(accuracy)}` : '—';

  const kmh = speed != null ? (speed * 3.6).toFixed(1) : '0.0';
  document.getElementById('h-speed').textContent = kmh;

  if (!S.tracking) return;

  if (S.lastPos) {
    const d = haversine(S.lastPos.lat, S.lastPos.lng, lat, lng);
    if (d >= 0.002 && d <= 0.06) {
      S.distanceKm += d;
      if (!S.accelReady) S.steps += Math.round(d * 1000 / S.strideMeter);
    }
  }

  S.lastPos = { lat, lng };
  S.routePoints.push({ lat, lng });
  S.weeklySteps[6] = S.steps;

  document.getElementById('c-pts').textContent    = S.routePoints.length;
  document.getElementById('route-pts') && (document.getElementById('route-pts').textContent = S.routePoints.length);

  mapAddPoint(lat, lng);
  S.calories = calcCalories(S.distanceKm, S.steps);
  renderUI();
}

function onGPSErr(e) {
  const msg = { 1:'Location permission denied.', 2:'GPS unavailable.', 3:'GPS timed out.' };
  setStatus(msg[e.code] ?? 'GPS error');
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACCELEROMETER
// ─────────────────────────────────────────────────────────────────────────────
function startAccel() {
  if (!window.DeviceMotionEvent) {
    document.getElementById('c-sensor').textContent = 'Not supported';
    document.getElementById('info-sensor').textContent = 'Not supported';
    return;
  }
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
      .then(r => r === 'granted' ? attachAccel() : noAccel('Denied'))
      .catch(() => noAccel('Error'));
  } else {
    attachAccel();
  }
}

function attachAccel() {
  S.accelReady = true;
  document.getElementById('c-sensor').textContent     = 'Active ✓';
  document.getElementById('info-sensor').textContent  = 'Accelerometer';
  window.addEventListener('devicemotion', onMotion);
}

function noAccel(r) {
  document.getElementById('c-sensor').textContent    = r + ' (GPS)';
  document.getElementById('info-sensor').textContent = 'GPS fallback';
}

function stopAccel() {
  window.removeEventListener('devicemotion', onMotion);
  S.accelReady = false;
  document.getElementById('c-sensor').textContent = '—';
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
      S.weeklySteps[6] = S.steps;
      S.calories = calcCalories(S.distanceKm, S.steps);
      renderUI();
    }
    S.lastPeak = true;
  } else if (delta < 0) {
    S.lastPeak = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  RENDER UI
// ─────────────────────────────────────────────────────────────────────────────
function renderUI() {
  const steps = S.steps;
  const dist  = S.distanceKm.toFixed(2);
  const cal   = Math.round(S.calories);
  const pct   = Math.min((steps / S.stepGoal) * 100, 100);

  // Dashboard
  document.getElementById('ring-steps').textContent  = steps.toLocaleString();
  document.getElementById('h-distance').textContent  = dist;
  document.getElementById('h-calories').textContent  = cal;

  // Ring progress (circumference = 2π×80 ≈ 502)
  const offset = 502 - (502 * pct / 100);
  document.getElementById('ring-circle').style.strokeDashoffset = offset;

  document.getElementById('goal-text').textContent =
    `${steps.toLocaleString()} / ${S.stepGoal.toLocaleString()}`;
  document.getElementById('goal-pct') &&
    (document.getElementById('goal-pct').textContent = pct.toFixed(0) + '%');

  // Map overlay stats
  document.getElementById('mo-steps').textContent = steps.toLocaleString();
  document.getElementById('mo-dist').textContent  = dist;

  // Stats page
  document.getElementById('ss-steps').textContent = steps.toLocaleString();
  document.getElementById('ss-dist').textContent  = dist;
  document.getElementById('ss-cal').textContent   = cal;
  document.getElementById('ps-fill').style.width  = pct + '%';
  document.getElementById('ps-pct').textContent   = pct.toFixed(0) + '%';
  document.getElementById('ps-steps-text').textContent = steps.toLocaleString() + ' steps';

  // Achievements
  checkAchievements(steps, S.distanceKm);

  // Chart today bar
  renderChart();
}

function updatePace(ms) {
  if (S.distanceKm < 0.01) return;
  const minPerKm = (ms / 60000) / S.distanceKm;
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  document.getElementById('c-pace').textContent = `${m}:${pad(s)}`;
}

function setStatus(msg) { document.getElementById('status-msg').textContent = msg; }

function setGPS(on) {
  const p = document.getElementById('gps-pill');
  p.textContent = on ? 'GPS On' : 'GPS Off';
  p.classList.toggle('on', on);
}

// ─────────────────────────────────────────────────────────────────────────────
//  WEEKLY BAR CHART
// ─────────────────────────────────────────────────────────────────────────────
function renderChart() {
  const days  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const today = new Date().getDay(); // 0=Sun
  const order = [];
  for (let i = 0; i < 7; i++) order.push((today - 6 + i + 7) % 7);

  const chartEl  = document.getElementById('bar-chart');
  const labelsEl = document.getElementById('bar-labels');
  if (!chartEl) return;

  const vals = S.weeklySteps;
  const max  = Math.max(...vals, 1);

  chartEl.innerHTML  = '';
  labelsEl.innerHTML = '';

  vals.forEach((v, i) => {
    const isToday = i === 6;
    const h = Math.max((v / max) * 100, 4);

    const wrap = document.createElement('div');
    wrap.className = 'bar-wrap';

    const bar = document.createElement('div');
    bar.className = 'bar' + (isToday ? ' today' : '');
    bar.style.height = h + '%';
    bar.setAttribute('data-val', v.toLocaleString());

    wrap.appendChild(bar);
    chartEl.appendChild(wrap);

    const lbl = document.createElement('div');
    lbl.className = 'bar-day' + (isToday ? ' today' : '');
    lbl.textContent = days[order[i]];
    labelsEl.appendChild(lbl);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  ACHIEVEMENTS
// ─────────────────────────────────────────────────────────────────────────────
function checkAchievements(steps, km) {
  if (steps >= 1000)  unlock('ach-1k');
  if (steps >= 5000)  unlock('ach-5k');
  if (steps >= 10000) unlock('ach-10k');
  if (km    >= 1)     unlock('ach-1km');
}
function unlock(id) {
  const el = document.getElementById(id);
  if (el) el.classList.replace('locked', 'unlocked');
}

// ─────────────────────────────────────────────────────────────────────────────
//  SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
function updateGoal(v) {
  S.stepGoal = parseInt(v);
  document.getElementById('goal-display').textContent = parseInt(v).toLocaleString();
  document.getElementById('ring-goal').textContent    = 'Goal: ' + parseInt(v).toLocaleString();
  renderUI();
}

function updateSensitivity(v) {
  S.STEP_THRESH = parseFloat(v);
  document.getElementById('sens-display').textContent = parseFloat(v).toFixed(2);
}

function updateStride(v) {
  S.strideMeter = parseFloat(v);
  document.getElementById('stride-display').textContent = parseFloat(v).toFixed(2) + ' m';
}

// ─────────────────────────────────────────────────────────────────────────────
//  MATH
// ─────────────────────────────────────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R    = 6371;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a    = Math.sin(dLat/2)**2 +
               Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function rad(d) { return d * Math.PI / 180; }
function calcCalories(km, steps) { return steps * 0.04 + km * 60; }

// ─────────────────────────────────────────────────────────────────────────────
//  BOOT
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Inject SVG gradient for ring
  const svg = document.querySelector('.ring-svg');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = `
    <linearGradient id="ringGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%"   stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#10b981"/>
    </linearGradient>`;
  svg.prepend(defs);

  // Date display
  document.getElementById('date-display').textContent =
    new Date().toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });

  // Check sensor availability
  document.getElementById('info-sensor').textContent =
    window.DeviceMotionEvent ? 'Available' : 'Not supported';

  initMap();
  renderChart();
});
