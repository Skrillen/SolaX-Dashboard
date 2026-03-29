
/* ——— Unités affichées (champs API Solax) ——— */
const FIELD_UNITS = {
  acpower: "W",
  yieldtoday: "kWh",
  yieldtotal: "kWh",
  powerdc1: "W",
  powerdc2: "W"
};

/* ——— Libellés statut onduleur (codes Solax) ——— */
const statusMap = {
  100: "En attente",
  102: "Normal",
  103: "Défaut récupérable",
  104: "Défaut permanent"
};

/* ——— Classes CSS selon inverterStatus ——— */
function statusClass(c) {
  if (c == 102) return "badge-normal";
  if (c == 103 || c == 104) return "badge-fault";
  if (c == 100) return "badge-waiting";
  return "badge-other";
}

/* ——— Échappement HTML et rendu nombre + unité dans le tableau ——— */
function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function asNonNegative(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

/** Arrondi à 0,01 près (affichage et totaux). */
function round2(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function cellMeasured(val, unit) {
  if (val === null || val === undefined || val === "") {
    return `<span class="cell-empty">—</span>`;
  }
  const v = escapeHtml(round2(asNonNegative(val)));
  const u = escapeHtml(unit);
  return `<span class="cell-value">${v}</span><span class="cell-unit">${u}</span>`;
}

/* ——— Sommes et compteurs (live / cache / erreurs) ——— */
function sum(data, field) {
  const s = data.reduce((a, b) => a + asNonNegative(b[field]), 0);
  return round2(s);
}

function countSources(data) {
  let live = 0;
  let cached = 0;
  let errors = 0;
  for (const d of data) {
    if (d._error) errors++;
    else if (d._fromCache) cached++;
    else live++;
  }
  return { live, cached, errors };
}

/* ——— true sur localhost / 127.0.0.1 (ex. logs « DATA FRONT ») ——— */
const isLocal =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

/* ——— Historique graphique : plusieurs jours (localStorage v2) ——— */
const POWER_CHART_STORAGE = "kerchSolarPowerDay_v1";
const CHART_SAMPLE_MS = 60 * 1000;
/** Fenêtre glissante : 7 jours calendaires (aujourd’hui + 6 jours en arrière) */
const CHART_RETENTION_DAYS = 7;

const CHART_STORE_V2 = 2;

let powerChart = null;
let todayHistoryPoints = [];
let chartViewDayKey = "";
let lastRecordedDayKey = null;
let lastPowerSampleTs = 0;

function getLocalDayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysToKey(dayKey, delta) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + delta);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** Plus ancien jour conservé / sélectionnable (inclus dans les 7 jours). */
function getChartOldestDayKey() {
  return addDaysToKey(getLocalDayKey(), -(CHART_RETENTION_DAYS - 1));
}

function pruneChartStoreDays(store) {
  if (!store || !store.days) return false;
  const oldest = getChartOldestDayKey();
  const today = getLocalDayKey();
  let removed = false;
  for (const k of Object.keys(store.days)) {
    if (k < oldest || k > today) {
      delete store.days[k];
      removed = true;
    }
  }
  return removed;
}

function dayBoundsMs(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  return { start, end };
}

function formatDayLabelFr(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

function readChartStore() {
  try {
    const raw = localStorage.getItem(POWER_CHART_STORAGE);
    if (!raw) return { version: CHART_STORE_V2, days: {} };
    const o = JSON.parse(raw);
    if (o.version === CHART_STORE_V2 && o.days && typeof o.days === "object") {
      const store = o;
      if (pruneChartStoreDays(store)) {
        try {
          writeChartStore(store);
        } catch {
          /* quota */
        }
      }
      return store;
    }
    if (o.day && Array.isArray(o.points)) {
      const store = { version: CHART_STORE_V2, days: { [o.day]: o.points } };
      if (pruneChartStoreDays(store)) {
        try {
          writeChartStore(store);
        } catch {
          /* quota */
        }
      }
      return store;
    }
  } catch {
    /* ignore */
  }
  return { version: CHART_STORE_V2, days: {} };
}

function writeChartStore(store) {
  pruneChartStoreDays(store);
  const days = store.days || {};
  localStorage.setItem(
    POWER_CHART_STORAGE,
    JSON.stringify({ version: CHART_STORE_V2, days })
  );
}

function getDayPointsFromStore(dayKey) {
  const store = readChartStore();
  const raw = store.days[dayKey];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => Array.isArray(p) && p.length === 2)
    .map(([t, w]) => ({
      x: t,
      y: round2(Math.max(0, w))
    }));
}

function setDayPointsInStore(dayKey, points) {
  try {
    const store = readChartStore();
    store.version = CHART_STORE_V2;
    store.days = store.days || {};
    store.days[dayKey] = points.map((p) => [p.x, p.y]);
    writeChartStore(store);
  } catch {
    /* quota */
  }
}

function handleMidnightRollover() {
  const today = getLocalDayKey();
  if (lastRecordedDayKey === null) {
    lastRecordedDayKey = today;
    return;
  }
  if (lastRecordedDayKey === today) return;
  todayHistoryPoints = [];
  lastPowerSampleTs = 0;
  lastRecordedDayKey = today;
}

function clampChartViewDayToWindow() {
  const oldest = getChartOldestDayKey();
  const today = getLocalDayKey();
  if (chartViewDayKey < oldest) chartViewDayKey = oldest;
  if (chartViewDayKey > today) chartViewDayKey = today;
}

function updateChartNavUI() {
  const labelEl = document.getElementById("chartDayLabel");
  const prevBtn = document.getElementById("chartPrevDay");
  const nextBtn = document.getElementById("chartNextDay");
  if (!labelEl || !prevBtn || !nextBtn) return;
  labelEl.textContent = formatDayLabelFr(chartViewDayKey);
  const today = getLocalDayKey();
  const oldest = getChartOldestDayKey();
  nextBtn.disabled = chartViewDayKey >= today;
  prevBtn.disabled = chartViewDayKey <= oldest;
}

function applyChartView() {
  if (!powerChart || !powerChart.data.datasets[0]) return;
  clampChartViewDayToWindow();
  const today = getLocalDayKey();
  const pts =
    chartViewDayKey === today
      ? todayHistoryPoints.slice()
      : getDayPointsFromStore(chartViewDayKey);
  powerChart.data.datasets[0].data = pts;
  const { start, end } = dayBoundsMs(chartViewDayKey);
  if (chartViewDayKey === today) {
    powerChart.options.scales.x.min = start;
    powerChart.options.scales.x.max = undefined;
  } else {
    powerChart.options.scales.x.min = start;
    powerChart.options.scales.x.max = end;
  }
  powerChart.update("none");
  updateChartNavUI();
}

function recordPowerSample(totalW) {
  handleMidnightRollover();
  const today = getLocalDayKey();
  const w = round2(asNonNegative(totalW));
  const now = Date.now();
  if (
    now - lastPowerSampleTs < CHART_SAMPLE_MS &&
    todayHistoryPoints.length > 0
  ) {
    return;
  }
  lastPowerSampleTs = now;
  todayHistoryPoints.push({ x: now, y: w });
  setDayPointsInStore(today, todayHistoryPoints);
  if (chartViewDayKey === today && powerChart && powerChart.data.datasets[0]) {
    powerChart.data.datasets[0].data = todayHistoryPoints.slice();
    powerChart.update("none");
  }
}

function initPowerChart() {
  if (typeof Chart === "undefined") return;
  const canvas = document.getElementById("chartPower");
  if (!canvas) return;

  const today = getLocalDayKey();
  lastRecordedDayKey = today;
  todayHistoryPoints = getDayPointsFromStore(today);
  if (todayHistoryPoints.length) {
    lastPowerSampleTs = todayHistoryPoints[todayHistoryPoints.length - 1].x;
  }
  chartViewDayKey = today;

  const tickColor = "#888";
  const gridColor = "rgba(255, 255, 255, 0.06)";

  powerChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      datasets: [
        {
          label: "Puissance totale (W)",
          data: [],
          borderColor: "#ff5a5a",
          backgroundColor: "rgba(255, 90, 90, 0.12)",
          borderWidth: 2,
          fill: true,
          tension: 0.2,
          pointRadius: 0,
          pointHoverRadius: 5
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "nearest", axis: "x" },
      scales: {
        x: {
          type: "time",
          time: {
            displayFormats: { minute: "HH:mm", hour: "HH:mm" }
          },
          grid: { color: gridColor },
          ticks: { color: tickColor, maxRotation: 0, autoSkip: true }
        },
        y: {
          min: 0,
          title: {
            display: true,
            text: "W",
            color: tickColor
          },
          grid: { color: gridColor },
          ticks: {
            color: tickColor,
            callback: (value) => round2(value)
          }
        }
      },
      plugins: {
        legend: {
          display: true,
          labels: { color: "#ccc" }
        },
        tooltip: {
          backgroundColor: "rgba(20, 20, 20, 0.95)",
          titleColor: "#f0f0f0",
          bodyColor: "#fecaca",
          borderColor: "#3d1515",
          borderWidth: 1,
          callbacks: {
            label(ctx) {
              const y = ctx.parsed.y;
              return `${ctx.dataset.label}: ${round2(y)} W`;
            }
          }
        }
      }
    }
  });

  applyChartView();

  const prevBtn = document.getElementById("chartPrevDay");
  const nextBtn = document.getElementById("chartNextDay");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      const oldest = getChartOldestDayKey();
      const prev = addDaysToKey(chartViewDayKey, -1);
      if (prev >= oldest) {
        chartViewDayKey = prev;
        applyChartView();
      }
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      const next = addDaysToKey(chartViewDayKey, 1);
      const todayK = getLocalDayKey();
      if (next <= todayK) {
        chartViewDayKey = next;
        applyChartView();
      }
    });
  }
}

/* ——— Stockage global des données ——— */
let globalData = [];

/* ——— Format du timestamp du cache en temps réel ——— */
function formatAgeFromTs(ts) {
  if (!ts) return "0s";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return sec + "s";
  return Math.floor(sec / 60) + "min " + (sec % 60) + "s";
}

/* ——— Chargement API /api/pv ——— */
async function load(options = {}) {
  const forceRefresh = options.forceRefresh === true;
  const btnRefresh = document.getElementById("btnRefresh");
  if (forceRefresh && btnRefresh) {
    btnRefresh.disabled = true;
    btnRefresh.setAttribute("aria-busy", "true");
  }

  const timeEl = document.getElementById("time");
  timeEl.classList.remove("is-error");

  try {
    const url = forceRefresh ? "/api/pv?refresh=1" : "/api/pv";
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    globalData = await res.json();

    if (isLocal) console.log("DATA FRONT:", globalData);

    const totalPower = sum(globalData, "acpower");
    recordPowerSample(totalPower);

    timeEl.textContent = "🕐 " + new Date().toLocaleString();

    renderDOM();

  } catch (e) {
    timeEl.textContent = "⚠️ Erreur de chargement — " + new Date().toLocaleString();
    timeEl.classList.add("is-error");
    console.error(e);
  } finally {
    if (forceRefresh && btnRefresh) {
      btnRefresh.disabled = false;
      btnRefresh.removeAttribute("aria-busy");
    }
  }
}

/* ——— Helper : Mise à jour du texte avec Micro-animation ——— */
function updateVal(id, textHtml, trackingValue) {
  const el = document.getElementById(id);
  if (!el) return;
  if (el.dataset.track !== String(trackingValue)) {
    el.innerHTML = textHtml;
    el.dataset.track = String(trackingValue);
    el.classList.remove("val-updated");
    void el.offsetWidth; // Reflow for restart animation
    el.classList.add("val-updated");
  }
}

let domInitialized = false;

/* ——— Rendu du DOM basé sur globalData ——— */
function renderDOM() {
  if (!globalData || globalData.length === 0) return;

  const totalPower = sum(globalData, "acpower");
  const totalToday = sum(globalData, "yieldtoday");
  const totalTotal = sum(globalData, "yieldtotal");
  const { live, cached, errors } = countSources(globalData);

  // 1. Initialisation unique de la structure
  if (!domInitialized) {
    document.getElementById("summary").innerHTML = `
      <div class="summary-bar">
        <div class="summary-chip"><span class="summary-chip__label">Live</span><span class="summary-chip__value" id="sum-live"></span></div>
        <div class="summary-chip cached"><span class="summary-chip__label">Cache</span><span class="summary-chip__value" id="sum-cached"></span></div>
        ${errors ? `<div class="summary-chip error"><span class="summary-chip__label">Erreur</span><span class="summary-chip__value" id="sum-errors"></span></div>` : '<div id="sum-errors" style="display:none"></div>'}
        <div class="summary-chip"><span class="summary-chip__label">Production total instantanée</span><span class="summary-chip__value" id="sum-power"></span></div>
        <div class="summary-chip"><span class="summary-chip__label">Production du jour</span><span class="summary-chip__value" id="sum-today"></span></div>
        <div class="summary-chip"><span class="summary-chip__label">Total depuis installation</span><span class="summary-chip__value" id="sum-total"></span></div>
      </div>
    `;

    const rows = globalData.map((r, i) => `
      <tr id="row-${escapeHtml(r._sn)}">
        <td data-label="#">${i + 1}</td>
        <td data-label="SN" class="sn-cell"><div class="sn-inline"><span class="sn">${escapeHtml(r._sn)}</span><span id="badge-${r._sn}"></span></div></td>
        <td data-label="Status"><span id="status-${r._sn}"></span></td>
        <td data-label="Prod. instant" class="num"><span id="val-acpower-${r._sn}"></span></td>
        <td data-label="Prod. jour" class="num"><span id="val-yieldtoday-${r._sn}"></span></td>
        <td data-label="Total" class="num"><span id="val-yieldtotal-${r._sn}"></span></td>
        <td data-label="Panneau 1" class="num"><span id="val-powerdc1-${r._sn}"></span></td>
        <td data-label="Panneau 2" class="num"><span id="val-powerdc2-${r._sn}"></span></td>
      </tr>
    `).join("");

    document.getElementById("table").innerHTML = `<div class="table-wrap"><table>
      <thead><tr>
        <th scope="col">#</th><th scope="col">SN</th><th scope="col">Status</th><th scope="col">Prod. instant</th>
        <th scope="col">Prod. jour</th><th scope="col">Total</th><th scope="col">Panneau 1</th><th scope="col">Panneau 2</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;

    domInitialized = true;
  }

  // 2. Mises à jour ciblées des données (DOM Diffing/Patching manuel)
  updateVal("sum-live", `<span class="summary-num">${escapeHtml(round2(live))}</span>`, live);
  updateVal("sum-cached", `<span class="summary-num">${escapeHtml(round2(cached))}</span>`, cached);
  updateVal("sum-errors", `<span class="summary-num">${escapeHtml(round2(errors))}</span>`, errors);
  updateVal("sum-power", `<span class="summary-num">${escapeHtml(totalPower)}</span><span class="summary-unit">W</span>`, totalPower);
  updateVal("sum-today", `<span class="summary-num">${escapeHtml(totalToday)}</span><span class="summary-unit">kWh</span>`, totalToday);
  updateVal("sum-total", `<span class="summary-num">${escapeHtml(totalTotal)}</span><span class="summary-unit">kWh</span>`, totalTotal);

  globalData.forEach(r => {
    if (r._error) {
       document.getElementById(`status-${r._sn}`).innerHTML = '<span class="badge badge-fault">Erreur</span>';
       return;
    }

    const cacheBadge = r._fromCache
      ? `<span class="badge badge-cache">cache (${formatAgeFromTs(r._cacheTimestamp)})</span>`
      : `<span class="badge badge-live">direct</span>`;
    const ageRaw = r._fromCache ? Math.floor(Date.now() - r._cacheTimestamp) : "live";
    
    updateVal(`badge-${r._sn}`, cacheBadge, ageRaw);
    updateVal(`status-${r._sn}`, `<span class="badge ${statusClass(r.inverterStatus)}">${escapeHtml(statusMap[r.inverterStatus] || "-")}</span>`, r.inverterStatus);
    
    updateVal(`val-acpower-${r._sn}`, cellMeasured(r.acpower, FIELD_UNITS.acpower), r.acpower);
    updateVal(`val-yieldtoday-${r._sn}`, cellMeasured(r.yieldtoday, FIELD_UNITS.yieldtoday), r.yieldtoday);
    updateVal(`val-yieldtotal-${r._sn}`, cellMeasured(r.yieldtotal, FIELD_UNITS.yieldtotal), r.yieldtotal);
    updateVal(`val-powerdc1-${r._sn}`, cellMeasured(r.powerdc1, FIELD_UNITS.powerdc1), r.powerdc1);
    updateVal(`val-powerdc2-${r._sn}`, cellMeasured(r.powerdc2, FIELD_UNITS.powerdc2), r.powerdc2);
  });
}

/* ——— Au chargement : graphique, bouton manuel, polling API (10s), UI update (1s) ——— */
document.addEventListener("DOMContentLoaded", () => {
  initPowerChart();
  document.getElementById("btnRefresh").addEventListener("click", () => {
    load({ forceRefresh: true }).catch(() => {});
  });
  
  load().catch(() => {});
  
  // Polling API toutes les 10 secondes vs chaque seconde
  setInterval(() => {
    load().catch(() => {});
  }, 10000);

  // Mise à jour fluide locale toutes les secondes
  setInterval(() => {
    renderDOM();
  }, 1000);
});

