
/* ——— Constantes de configuration ——— */
const FIELD_UNITS = { acpower: "W", yieldtoday: "kWh", yieldtotal: "kWh", powerdc1: "W", powerdc2: "W" };
const CHART_RETENTION_DAYS = 7;
const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";

/* ——— Libellés & styles statut onduleur ——— */
const statusMap = { 100: "En attente", 102: "Normal", 103: "Défaut récupérable", 104: "Défaut permanent" };
function statusClass(c) {
  if (c == 102) return "badge-normal";
  if (c == 103 || c == 104) return "badge-fault";
  if (c == 100) return "badge-waiting";
  return "badge-other";
}

/* ——— Utilitaires de formatage ——— */
function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function asNonNegative(v) { const n = parseFloat(v); return Number.isFinite(n) ? Math.max(0, n) : 0; }
function round2(v)        { const n = Number(v);      return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }

/** Bascule W → kW au-dessus de 1 000, ou Wh → kWh pour un rendement. */
function formatVal(val, unit) {
  const v = asNonNegative(val);
  if (unit === "W")   return v >= 1000 ? { v: round2(v / 1000), u: "kW" } : { v: Math.round(v), u: "W" };
  if (unit === "kWh") return v > 0 && v < 1 ? { v: Math.round(v * 1000), u: "Wh" } : { v: round2(v), u: "kWh" };
  return { v: round2(v), u: unit };
}

function cellMeasured(val, unit) {
  if (val == null || val === "") return `<span class="cell-empty">—</span>`;
  const { v, u } = formatVal(val, unit);
  return `<span class="cell-value">${escapeHtml(v)}</span><span class="cell-unit">${escapeHtml(u)}</span>`;
}

function numSpan(val, unit, extraStyle = "") {
  const { v, u } = formatVal(val, unit);
  const style = extraStyle ? ` style="${extraStyle}"` : "";
  return `<span class="summary-num"${style}>${escapeHtml(v)}</span><span class="summary-unit">${escapeHtml(u)}</span>`;
}

/* ——— Agrégats ——— */
function sum(data, field) { return round2(data.reduce((a, b) => a + asNonNegative(b[field]), 0)); }
function countSources(data) {
  let live = 0, cached = 0, errors = 0;
  const now = Date.now();
  for (const d of data) {
    if (d._error) errors++;
    else if (!d._fromCache || (now - d._cacheTimestamp < 4000)) live++;
    else cached++;
  }
  return { live, cached, errors };
}

/* ——— État global ——— */
let globalData     = [];
let globalMeterData = null;
let isPaused       = false;
let domInitialized = false;

/* ——— Graphique historique ——— */
let powerChart     = null;
let chartViewDayKey = "";
let serverHistory  = { days: {} };
let forecastData   = { hourly: [], daily: { predictedYield24h: 0 } };

/* ——— Helpers date / graphique ——— */
function getLocalDayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function addDaysToKey(dayKey, delta) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m-1, d);
  dt.setDate(dt.getDate() + delta);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
}
function getChartOldestDayKey() { return addDaysToKey(getLocalDayKey(), -(CHART_RETENTION_DAYS - 1)); }
function dayBoundsMs(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return { start: new Date(y, m-1, d, 0,0,0,0).getTime(), end: new Date(y, m-1, d, 23,59,59,999).getTime() };
}
function formatDayLabelFr(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m-1, d).toLocaleDateString("fr-FR", { weekday:"long", day:"numeric", month:"long", year:"numeric" });
}
function getDayPointsFromServer(dayKey) {
  const raw = serverHistory.days[dayKey];
  if (!Array.isArray(raw)) return [];
  return raw.map(pt => ({ x: pt[0], y: round2(Math.max(0, pt[1])), house: pt[2] != null ? round2(Math.max(0, pt[2])) : null }));
}

/* ——— Navigation graphique ——— */
function updateChartNavUI() {
  const labelEl = document.getElementById("chartDayLabel");
  const prevBtn = document.getElementById("chartPrevDay");
  const nextBtn = document.getElementById("chartNextDay");
  if (!labelEl || !prevBtn || !nextBtn) return;
  labelEl.textContent = formatDayLabelFr(chartViewDayKey);
  const today = getLocalDayKey(), oldest = getChartOldestDayKey();
  nextBtn.disabled = chartViewDayKey >= today;
  prevBtn.disabled = chartViewDayKey <= oldest;
}

function applyChartView() {
  if (!powerChart || !powerChart.data.datasets[2]) return;
  const oldest = getChartOldestDayKey(), today = getLocalDayKey();
  if (chartViewDayKey < oldest) chartViewDayKey = oldest;
  if (chartViewDayKey > today)  chartViewDayKey = today;

  const isToday   = chartViewDayKey === today;
  const pts       = getDayPointsFromServer(chartViewDayKey);

  powerChart.data.datasets[2].data = pts.map(p => ({ x: p.x, y: p.y }));
  if (powerChart.data.datasets[3]) {
    powerChart.data.datasets[3].data = pts.filter(p => p.house != null).map(p => ({ x: p.x, y: p.house }));
  }

  if (isToday) {
    const yPts = getDayPointsFromServer(addDaysToKey(today, -1));
    powerChart.data.datasets[0].data   = yPts.map(p => ({ x: p.x, y: p.y }));
    powerChart.data.datasets[0].hidden = false;
    powerChart.data.datasets[1].data   = forecastData.hourly.filter(h => h.time > Date.now()).map(h => ({ x: h.time, y: h.predictedPower }));
    powerChart.data.datasets[1].hidden = false;
  } else {
    powerChart.data.datasets[0].data   = [];
    powerChart.data.datasets[1].data   = [];
    powerChart.data.datasets[0].hidden = true;
    powerChart.data.datasets[1].hidden = true;
  }

  const { start, end } = dayBoundsMs(chartViewDayKey);
  powerChart.options.scales.x.min = start;
  powerChart.options.scales.x.max = end;
  powerChart.update();
  updateChartNavUI();
  updateChartStats();
}

function updateChartStats() {
  const statsEl = document.getElementById("chart-day-stats");
  if (!statsEl) return;
  const pts = getDayPointsFromServer(chartViewDayKey);
  let totalYield = 0, peakPower = 0;
  if (pts.length > 0) {
    peakPower = Math.max(...pts.map(p => p.y));
    for (let i = 1; i < pts.length; i++) {
      totalYield += ((pts[i].y + pts[i-1].y) / 2) * ((pts[i].x - pts[i-1].x) / 3_600_000);
    }
  }
  const { v: kY, u: uY } = formatVal(totalYield, "kWh");
  const { v: kP, u: uP } = formatVal(peakPower, "W");
  statsEl.innerHTML = `
    <div class="chart-stat-item"><span class="chart-stat-label">Rendement</span><span class="chart-stat-value">${kY} ${uY}</span></div>
    <div class="chart-stat-item"><span class="chart-stat-label">Pic</span><span class="chart-stat-value">${kP} ${uP}</span></div>`;
}

function initPowerChart() {
  if (typeof Chart === "undefined") return;
  const canvas = document.getElementById("chartPower");
  if (!canvas) return;
  chartViewDayKey = getLocalDayKey();

  const TC = "#888", GC = "rgba(255,255,255,0.06)";
  const dsBase = { tension: 0.2, pointRadius: 0, pointHoverRadius: 5 };

  powerChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { datasets: [
      { label: "Hier", data: [], borderColor: "rgba(255,255,255,0.25)", backgroundColor: "transparent", borderWidth: 1.5, borderDash: [6,4], fill: false, pointHoverRadius: 4, ...dsBase },
      { label: "Prédiction", data: [], borderColor: "rgba(34,197,94,0.6)", backgroundColor: "transparent", borderWidth: 2, borderDash: [4,4], fill: false, tension: 0.3, pointHoverRadius: 4, pointRadius: 0 },
      { label: "Production (W)", data: [], borderColor: "#ff5a5a", backgroundColor: "rgba(255,90,90,0.12)", borderWidth: 2, fill: true, ...dsBase },
      { label: "Conso. Maison (W)", data: [], borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,0.12)", borderWidth: 2, fill: true, ...dsBase }
    ]},
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { intersect: false, mode: "nearest", axis: "x" },
      scales: {
        x: { type: "time", time: { unit: "hour", displayFormats: { millisecond:"HH:mm", second:"HH:mm", minute:"HH:mm", hour:"HH:mm", day:"HH:mm" } }, grid: { color: GC }, ticks: { color: TC, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 } },
        y: { min: 0, title: { display: true, text:"W", color: TC }, grid: { color: GC }, ticks: { color: TC, callback: v => round2(v) } }
      },
      plugins: {
        legend: { display: true, labels: { color: "#ccc" } },
        tooltip: {
          backgroundColor: "rgba(20,20,20,0.95)", titleColor: "#f0f0f0", bodyColor: "#fecaca", borderColor: "#3d1515", borderWidth: 1,
          callbacks: {
            title(items) { if (!items.length) return ""; const d = new Date(items[0].parsed.x); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; },
            label(ctx)   { return `${ctx.dataset.label}: ${round2(ctx.parsed.y)} W`; }
          }
        }
      }
    }
  });

  applyChartView();

  const prevBtn = document.getElementById("chartPrevDay");
  const nextBtn = document.getElementById("chartNextDay");
  prevBtn?.addEventListener("click", () => {
    const prev = addDaysToKey(chartViewDayKey, -1);
    if (prev >= getChartOldestDayKey()) { chartViewDayKey = prev; applyChartView(); }
  });
  nextBtn?.addEventListener("click", () => {
    const next = addDaysToKey(chartViewDayKey, 1);
    if (next <= getLocalDayKey()) { chartViewDayKey = next; applyChartView(); }
  });
}

/* ——— Tweening (animation compteur) ——— */
function easeOutExpo(x) { return x === 1 ? 1 : 1 - Math.pow(2, -10 * x); }

function updateVal(id, html, trackingValue) {
  const el = document.getElementById(id);
  if (!el) return;
  const oldTrack = el.dataset.track;
  const strTrack = String(trackingValue);
  if (oldTrack === strTrack) return;

  const oldVal = parseFloat(oldTrack);
  const newVal = parseFloat(strTrack);

  if (!isNaN(oldVal) && !isNaN(newVal) && oldVal !== newVal) {
    let startTime = null;
    const animate = (now) => {
      if (!startTime) startTime = now;
      const progress = Math.min((now - startTime) / 600, 1);
      const current  = oldVal + (newVal - oldVal) * easeOutExpo(progress);
      el.innerHTML = html.replace(
        /(class="(?:summary-num|cell-value)"[^>]*>)([^<]*)(<\/span>)/,
        (_, p1, _p2, p3) => `${p1}${Math.abs(current) < 100 ? round2(current) : Math.round(current)}${p3}`
      );
      if (progress < 1) requestAnimationFrame(animate);
      else              el.innerHTML = html;
    };
    requestAnimationFrame(animate);
  } else {
    el.innerHTML = html;
  }

  el.dataset.track = strTrack;
  el.classList.remove("val-updated");
  void el.offsetWidth;
  el.classList.add("val-updated");
}

/* ——— Icône météo animée ——— */
function updateWeatherIcon() {
  const iconEl = document.getElementById("weather-icon");
  if (!iconEl || !forecastData.hourly?.length) return;
  const avgCloud = forecastData.hourly.slice(0, 12).reduce((a, h) => a + h.cloudCover, 0) / 12;
  const icon = avgCloud < 20 ? '<span class="icon-sun">☀️</span>'
             : avgCloud < 55 ? '<span class="icon-cloud">⛅</span>'
             : avgCloud < 85 ? '<span class="icon-cloud">☁️</span>'
                             : '<span class="icon-cloud">🌧️</span>';
  if (iconEl.innerHTML !== icon) iconEl.innerHTML = icon;
}

/* ——— Rendu principal ——— */
function renderDOM() {
  if (!globalData?.length) return;

  const totalPower = sum(globalData, "acpower");
  const totalToday = sum(globalData, "yieldtoday");
  const totalTotal = sum(globalData, "yieldtotal");
  const { errors }  = countSources(globalData);

  // — Init structure DOM (une seule fois) —
  if (!domInitialized) {
    document.getElementById("summary").innerHTML = `
      <div class="summary-bar">
        <div class="summary-chip cached">
          <span class="summary-chip__label" id="refresh-trigger" title="Double-clic pour forcer la mise à jour">Actualisation</span>
          <span class="summary-chip__value" id="sum-cache-timer"></span>
        </div>
        ${errors ? `<div class="summary-chip error"><span class="summary-chip__label">Erreur</span><span class="summary-chip__value" id="sum-errors"></span></div>` : '<div id="sum-errors" style="display:none"></div>'}
        <div class="summary-chip" id="chip-house-power" style="display:none"><span class="summary-chip__label">Conso. Maison</span><span class="summary-chip__value" id="houseConsumption"></span></div>
        <div class="summary-chip"><span class="summary-chip__label">Prod. instantanée</span><span class="summary-chip__value" id="sum-power"></span></div>
        <div class="summary-chip" id="chip-grid-power" style="display:none"><span class="summary-chip__label" id="gridFlowLabel">Réseau</span><span class="summary-chip__value" id="gridPower"></span></div>
        <div class="summary-chip" id="chip-autarcie" style="display:none"><span class="summary-chip__label">Indépendance</span><span class="summary-chip__value" id="val-autarcie"></span></div>
        <div class="summary-chip" id="chip-autoconso" style="display:none"><span class="summary-chip__label">Auto-conso</span><span class="summary-chip__value" id="val-autoconso"></span></div>
        <div class="summary-chip"><span class="summary-chip__label">Aujourd'hui</span><span class="summary-chip__value" id="sum-today"></span></div>
        <div class="summary-chip forecast"><span class="summary-chip__label">Prévision <span class="weather-icon" id="weather-icon"></span></span><span class="summary-chip__value" id="sum-forecast"></span></div>
        <div class="summary-chip installation"><span class="summary-chip__label">Total Historique</span><span class="summary-chip__value" id="sum-total"></span></div>
      </div>`;

    const trigger = document.getElementById("refresh-trigger");
    if (trigger) {
      trigger.addEventListener("dblclick", forceServerRefresh);
      let lastTap = 0;
      trigger.addEventListener("touchend", () => {
        const now = Date.now();
        if (now - lastTap < 300) forceServerRefresh();
        lastTap = now;
      });
    }

    const rows = globalData.map((r, i) => `
      <tr id="row-${escapeHtml(r._sn)}">
        <td data-label="#">${i + 1}</td>
        <td data-label="SN" class="sn-cell"><span class="sn">${escapeHtml(r._sn)}</span></td>
        <td data-label="Status"><span id="status-${r._sn}"></span></td>
        <td data-label="Prod. instant" class="num"><span id="val-acpower-${r._sn}"></span></td>
        <td data-label="Prod. jour" class="num"><span id="val-yieldtoday-${r._sn}"></span></td>
        <td data-label="Total" class="num"><span id="val-yieldtotal-${r._sn}"></span></td>
        <td data-label="Panneau 1" class="num"><span id="val-powerdc1-${r._sn}"></span></td>
        <td data-label="Panneau 2" class="num"><span id="val-powerdc2-${r._sn}"></span></td>
      </tr>`).join("");

    document.getElementById("table").innerHTML = `<div class="table-wrap"><table>
      <thead><tr>
        <th scope="col">#</th><th scope="col">SN</th><th scope="col">Status</th>
        <th scope="col">Prod. instant</th><th scope="col">Prod. jour</th>
        <th scope="col">Total</th><th scope="col">Panneau 1</th><th scope="col">Panneau 2</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

    domInitialized = true;
  }

  // — Mise à jour cartes résumé —
  updateVal("sum-errors",  `<span class="summary-num">${errors}</span>`, errors);
  updateVal("sum-power",   numSpan(totalPower, "W"),   totalPower);
  updateVal("sum-today",   numSpan(totalToday, "kWh"), totalToday);
  updateVal("sum-total",   numSpan(totalTotal, "kWh"), totalTotal);

  const forecastVal = forecastData.daily?.predictedYield24h ?? 0;
  updateVal("sum-forecast", numSpan(forecastVal, "kWh"), forecastVal);
  updateWeatherIcon();

  // — Meter (Réseau, Maison, KPIs) —
  const showMeter = !!globalMeterData;
  const toggle = (id, show) => { const el = document.getElementById(id); if (el) el.style.display = show ? "flex" : "none"; };
  ["chip-house-power", "chip-grid-power", "chip-autarcie", "chip-autoconso"].forEach(id => toggle(id, showMeter));

  if (showMeter) {
    const gridPower  = globalMeterData.totalActivePower || 0;
    const housePower = Math.max(0, totalPower - gridPower);

    updateVal("houseConsumption", numSpan(housePower, "W"), housePower);

    const gColor = gridPower > 0 ? "var(--accent-success)" : gridPower < 0 ? "var(--accent-danger)" : "var(--text-secondary)";
    const gIcon  = gridPower > 0 ? "▲" : gridPower < 0 ? "▼" : "■";
    const { v: gv, u: gu } = formatVal(Math.abs(gridPower), "W");
    updateVal("gridPower", `<span style="color:${gColor}"><span class="summary-num">${escapeHtml(gv)}</span><span class="summary-unit">${escapeHtml(gu)}</span> <span style="font-size:0.6em;margin-left:4px">${gIcon}</span></span>`, gridPower);

    const elLabel = document.getElementById("gridFlowLabel");
    const labelStr = gridPower > 0 ? "Export Réseau" : gridPower < 0 ? "Import Réseau" : "Réseau équilibré";
    if (elLabel && elLabel.innerText !== labelStr) elLabel.innerText = labelStr;

    // KPI Autoconsommation : % de la prod. PV consommée localement
    const autoConso = totalPower > 0 ? Math.round(Math.max(0, totalPower - Math.max(0, gridPower)) / totalPower * 100) : 0;
    updateVal("val-autoconso", `<span class="summary-num" style="color:var(--accent-success)">${autoConso} %</span>`, autoConso);

    // KPI Autarcie : % de la conso. maison couverte par le solaire
    let autarcie = 0;
    if (housePower > 0) {
      const pvUsed = Math.max(0, housePower - Math.abs(Math.min(0, gridPower)));
      autarcie = Math.round(pvUsed / housePower * 100);
    } else if (totalPower > 0) {
      autarcie = 100;
    }
    updateVal("val-autarcie", `<span class="summary-num" style="color:var(--accent-success)">${autarcie} %</span>`, autarcie);
  }

  // — Mode Nuit —
  document.body.classList.toggle("is-night", totalPower === 0);

  // — Timer cache —
  const timestamps = globalData.filter(d => d._cacheTimestamp).map(d => d._cacheTimestamp);
  const maxTs      = timestamps.length ? Math.max(...timestamps) : 0;
  const ageMs      = maxTs ? Date.now() - maxTs : Infinity;
  const isLive     = ageMs < 5000;

  const timerParent = document.getElementById("sum-cache-timer")?.closest(".summary-chip");
  if (timerParent) {
    timerParent.classList.toggle("is-paused", isPaused);
    timerParent.classList.toggle("is-live",   !isPaused && isLive);
  }
  const timerHtml = isPaused
    ? `<span class="status-dot pause"></span><span class="summary-num">Pause</span>`
    : isLive
    ? `<span class="status-dot pulse"></span><span class="summary-num">Direct</span>`
    : (() => { const s = Math.floor(ageMs / 1000); const m = Math.floor(s / 60); return `<span class="summary-num">${m > 0 ? m + "m " : ""}${s % 60}</span><span class="summary-unit">s</span>`; })();
  updateVal("sum-cache-timer", timerHtml, maxTs);

  // — Tableau onduleurs —
  globalData.forEach(r => {
    if (r._error) {
      const el = document.getElementById(`status-${r._sn}`);
      if (el) el.innerHTML = '<span class="badge badge-fault">Erreur</span>';
      return;
    }
    updateVal(`status-${r._sn}`,        `<span class="badge ${statusClass(r.inverterStatus)}">${escapeHtml(statusMap[r.inverterStatus] || "-")}</span>`, r.inverterStatus);
    updateVal(`val-acpower-${r._sn}`,   cellMeasured(r.acpower,    FIELD_UNITS.acpower),    r.acpower);
    updateVal(`val-yieldtoday-${r._sn}`,cellMeasured(r.yieldtoday, FIELD_UNITS.yieldtoday), r.yieldtoday);
    updateVal(`val-yieldtotal-${r._sn}`,cellMeasured(r.yieldtotal, FIELD_UNITS.yieldtotal), r.yieldtotal);
    updateVal(`val-powerdc1-${r._sn}`,  cellMeasured(r.powerdc1,   FIELD_UNITS.powerdc1),   r.powerdc1);
    updateVal(`val-powerdc2-${r._sn}`,  cellMeasured(r.powerdc2,   FIELD_UNITS.powerdc2),   r.powerdc2);
  });
}

/* ——— Timer léger (1s) — ne met à jour que le badge d'âge ——— */
function updateTimerBadges() {
  if (!globalData?.length) return;
  const timestamps = globalData.filter(d => d._cacheTimestamp).map(d => d._cacheTimestamp);
  if (!timestamps.length) return;
  const maxTs  = Math.max(...timestamps);
  const ageMs  = Date.now() - maxTs;
  const isLive = ageMs < 5000;

  const timerEl = document.getElementById("sum-cache-timer");
  if (!timerEl) return;

  const timerParent = timerEl.closest(".summary-chip");
  if (timerParent) {
    timerParent.classList.toggle("is-paused", isPaused);
    timerParent.classList.toggle("is-live",   !isPaused && isLive);
  }
  timerEl.innerHTML = isPaused
    ? `<span class="status-dot pause"></span><span class="summary-num">Pause</span>`
    : isLive
    ? `<span class="status-dot pulse"></span><span class="summary-num">Direct</span>`
    : (() => { const s = Math.floor(ageMs / 1000); const m = Math.floor(s / 60); return `<span class="summary-num">${m > 0 ? m + "m " : ""}${s % 60}</span><span class="summary-unit">s</span>`; })();

  // Horloge
  const timeEl = document.getElementById("time");
  if (timeEl && !timeEl.classList.contains("is-error")) {
    timeEl.textContent = "🕐 " + new Date().toLocaleString();
  }
}

/* ——— Icône météo animée ——— */
function updateWeatherIcon() {
  const iconEl = document.getElementById("weather-icon");
  if (!iconEl || !forecastData.hourly?.length) return;
  const avgCloud = forecastData.hourly.slice(0, 12).reduce((a, h) => a + h.cloudCover, 0) / 12;
  const icon = avgCloud < 20 ? '<span class="icon-sun">☀️</span>'
             : avgCloud < 55 ? '<span class="icon-cloud">⛅</span>'
             : avgCloud < 85 ? '<span class="icon-cloud">☁️</span>'
                             : '<span class="icon-cloud">🌧️</span>';
  if (iconEl.innerHTML !== icon) iconEl.innerHTML = icon;
}

/* ——— Force-refresh serveur ——— */
async function forceServerRefresh() {
  const btn = document.getElementById("refresh-trigger");
  if (btn) btn.style.opacity = "0.5";
  try {
    const res  = await fetch("/api/mgmt/force-refresh", { method: "POST" });
    const data = await res.json();
    showToast(res.ok ? "🚀 Rafraîchissement lancé !" : (data.error || "Erreur."), res.ok ? "success" : "error");
  } catch {
    showToast("⚠️ Erreur de connexion.", "error");
  }
  if (btn) btn.style.opacity = "1";
}

/* ——— Toast ——— */
let toastTimer = null;
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  if (!el) return;
  if (toastTimer) clearTimeout(toastTimer);
  el.textContent = msg;
  el.className = `toast is-visible${type ? " is-" + type : ""}`;
  toastTimer = setTimeout(() => el.classList.remove("is-visible"), 3500);
}

/* ——— SSE ——— */
let eventSource    = null;
let reconnectTimer = null;
let sseAlive       = false; // SSE connecté et reçoit des données

function parsePvPayload(payload) {
  globalData      = payload.inverters || payload;
  globalMeterData = payload.meter || null;
  isPaused        = payload._isPaused || false;
}

function connectSSE() {
  eventSource?.close();
  eventSource = new EventSource("/api/events");

  eventSource.addEventListener("pv", (e) => {
    try {
      parsePvPayload(JSON.parse(e.data));
      sseAlive = true;
      if (isLocal) console.log("SSE PV:", globalData);
      const timeEl = document.getElementById("time");
      if (timeEl) { timeEl.classList.remove("is-error"); timeEl.textContent = "🕐 " + new Date().toLocaleString(); }
      renderDOM();
    } catch (err) { console.error("SSE pv parse error:", err); }
  });

  eventSource.addEventListener("history", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data?.days) { serverHistory = data; applyChartView(); }
    } catch (err) { console.error("SSE history parse error:", err); }
  });

  eventSource.addEventListener("forecast", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data?.hourly || data?.daily) { forecastData = data; applyChartView(); renderDOM(); }
    } catch (err) { console.error("SSE forecast parse error:", err); }
  });

  eventSource.onerror = () => {
    console.warn("SSE connexion perdue, reconnexion dans 5s…");
    sseAlive = false;
    eventSource.close();
    const timeEl = document.getElementById("time");
    if (timeEl) { timeEl.textContent = "⚠️ Connexion perdue — reconnexion…"; timeEl.classList.add("is-error"); }
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSSE, 5000);
  };
}

/* ——— Chargement initial (REST) ——— */
async function initialLoad() {
  try {
    const [pvRes, histRes, fcRes] = await Promise.all([
      fetch("/api/pv?t="       + Date.now()),
      fetch("/api/history?t="  + Date.now()),
      fetch("/api/forecast?t=" + Date.now())
    ]);
    if (pvRes.ok) {
      parsePvPayload(await pvRes.json());
      const timeEl = document.getElementById("time");
      if (timeEl) { timeEl.classList.remove("is-error"); timeEl.textContent = "🕐 " + new Date().toLocaleString(); }
      renderDOM();
    }
    if (histRes.ok) { const d = await histRes.json(); if (d?.days) { serverHistory = d; applyChartView(); } }
    if (fcRes.ok)   { const d = await fcRes.json();   if (d?.hourly || d?.daily) { forecastData = d; applyChartView(); renderDOM(); } }
  } catch (e) { console.error("Erreur chargement initial:", e); }
}

/* ——— Fallbacks REST seulement si SSE est mort ——— */
async function fallbackPoll() {
  if (sseAlive) return; // Ne pas polluer si le SSE fonctionne
  try {
    const res = await fetch("/api/pv?t=" + Date.now());
    if (!res.ok) return;
    parsePvPayload(await res.json());
    const timeEl = document.getElementById("time");
    if (timeEl) { timeEl.classList.remove("is-error"); timeEl.textContent = "🕐 " + new Date().toLocaleString(); }
    renderDOM();
  } catch { /* silencieux */ }
}
async function fallbackHistoryPoll() {
  if (sseAlive) return;
  try { const res = await fetch("/api/history?t=" + Date.now()); if (!res.ok) return; const d = await res.json(); if (d?.days) { serverHistory = d; applyChartView(); } } catch { }
}
async function fallbackForecastPoll() {
  try { const res = await fetch("/api/forecast?t=" + Date.now()); if (!res.ok) return; const d = await res.json(); if (d?.hourly || d?.daily) { forecastData = d; applyChartView(); renderDOM(); } } catch { }
}

/* ——— Point d'entrée ——— */
document.addEventListener("DOMContentLoaded", () => {
  initPowerChart();
  initialLoad();
  connectSSE();

  setInterval(updateTimerBadges,   1_000);
  setInterval(fallbackPoll,       10_000);
  setInterval(fallbackHistoryPoll,65_000);
  setInterval(fallbackForecastPoll, 3_600_000);

  // PWA Service Worker
  if (location.hostname !== "localhost" && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(e => console.warn("SW:", e));
  }

  // Hors-ligne
  window.addEventListener("offline", () => document.body.classList.add("is-offline"));
  window.addEventListener("online",  () => { document.body.classList.remove("is-offline"); initialLoad().then(connectSSE); });
  if (!navigator.onLine) document.body.classList.add("is-offline");
});
