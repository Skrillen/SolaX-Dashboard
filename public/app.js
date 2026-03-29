
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
  const now = Date.now();
  for (const d of data) {
    if (d._error) errors++;
    else if (!d._fromCache || (now - d._cacheTimestamp < 4000)) live++;
    else cached++;
  }
  return { live, cached, errors };
}

/* ——— true sur localhost / 127.0.0.1 (ex. logs « DATA FRONT ») ——— */
const isLocal =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

/* ——— Historique graphique : plusieurs jours (Serveur) ——— */
const CHART_RETENTION_DAYS = 7;
let powerChart = null;
let chartViewDayKey = "";
let serverHistory = { days: {} };

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

function getChartOldestDayKey() {
  return addDaysToKey(getLocalDayKey(), -(CHART_RETENTION_DAYS - 1));
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

function getDayPointsFromServer(dayKey) {
  const raw = serverHistory.days[dayKey];
  if (!Array.isArray(raw)) return [];
  return raw.map(([t, w]) => ({
    x: t,
    y: round2(Math.max(0, w))
  }));
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

  const pts = getDayPointsFromServer(chartViewDayKey);
  powerChart.data.datasets[0].data = pts;

  const { start, end } = dayBoundsMs(chartViewDayKey);
  powerChart.options.scales.x.min = start;
  powerChart.options.scales.x.max = end;
  powerChart.update("none");
  updateChartNavUI();
}

function initPowerChart() {
  if (typeof Chart === "undefined") return;
  const canvas = document.getElementById("chartPower");
  if (!canvas) return;

  const today = getLocalDayKey();
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
            unit: "hour",
            displayFormats: {
              millisecond: "HH:mm",
              second: "HH:mm",
              minute: "HH:mm",
              hour: "HH:mm",
              day: "HH:mm"
            }
          },
          grid: { color: gridColor },
          ticks: {
            color: tickColor,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12
          }
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
            title(items) {
              if (!items.length) return "";
              const date = new Date(items[0].parsed.x);
              const hh = String(date.getHours()).padStart(2, "0");
              const mm = String(date.getMinutes()).padStart(2, "0");
              return `${hh}:${mm}`;
            },
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

/* ——— Rendu complet du DOM (appelé une fois + à chaque nouveau PV data) ——— */
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
        <div class="summary-chip cached">
          <span class="summary-chip__label">Actualisation</span>
          <span class="summary-chip__value" id="sum-cache-timer"></span>
        </div>
        ${errors ? `<div class="summary-chip error"><span class="summary-chip__label">Erreur</span><span class="summary-chip__value" id="sum-errors"></span></div>` : '<div id="sum-errors" style="display:none"></div>'}
        <div class="summary-chip"><span class="summary-chip__label">Production total instantanée</span><span class="summary-chip__value" id="sum-power"></span></div>
        <div class="summary-chip"><span class="summary-chip__label">Production du jour</span><span class="summary-chip__value" id="sum-today"></span></div>
        <div class="summary-chip"><span class="summary-chip__label">Total depuis installation</span><span class="summary-chip__value" id="sum-total"></span></div>
      </div>
    `;

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

  // 2. Mises à jour ciblées des données
  updateVal("sum-errors", `<span class="summary-num">${escapeHtml(round2(errors))}</span>`, errors);
  updateVal("sum-power", `<span class="summary-num">${escapeHtml(totalPower)}</span><span class="summary-unit">W</span>`, totalPower);
  updateVal("sum-today", `<span class="summary-num">${escapeHtml(totalToday)}</span><span class="summary-unit">kWh</span>`, totalToday);
  updateVal("sum-total", `<span class="summary-num">${escapeHtml(totalTotal)}</span><span class="summary-unit">kWh</span>`, totalTotal);

  // Mise à jour du timer global
  const maxTs = Math.max(...globalData.filter(d => d._cacheTimestamp).map(d => d._cacheTimestamp));
  const ageMs = Date.now() - maxTs;
  const isLive = ageMs < 5000;
  
  const timerParent = document.getElementById("sum-cache-timer")?.closest(".summary-chip");
  if (timerParent) {
    if (isLive) timerParent.classList.add("is-live");
    else timerParent.classList.remove("is-live");
  }

  let labelHtml = "";
  if (isLive) {
    labelHtml = `<span class="status-dot pulse"></span><span class="summary-num">Direct</span>`;
  } else {
    const ageSec = Math.floor(ageMs / 1000);
    const min = Math.floor(ageSec / 60);
    const sec = ageSec % 60;
    labelHtml = `<span class="summary-num">${min > 0 ? min + "m " : ""}${sec}</span><span class="summary-unit">s</span>`;
  }
  updateVal("sum-cache-timer", labelHtml, maxTs);

  globalData.forEach(r => {
    if (r._error) {
       const statusEl = document.getElementById(`status-${r._sn}`);
       if (statusEl) statusEl.innerHTML = '<span class="badge badge-fault">Erreur</span>';
       return;
    }

    updateVal(`status-${r._sn}`, `<span class="badge ${statusClass(r.inverterStatus)}">${escapeHtml(statusMap[r.inverterStatus] || "-")}</span>`, r.inverterStatus);

    updateVal(`val-acpower-${r._sn}`, cellMeasured(r.acpower, FIELD_UNITS.acpower), r.acpower);
    updateVal(`val-yieldtoday-${r._sn}`, cellMeasured(r.yieldtoday, FIELD_UNITS.yieldtoday), r.yieldtoday);
    updateVal(`val-yieldtotal-${r._sn}`, cellMeasured(r.yieldtotal, FIELD_UNITS.yieldtotal), r.yieldtotal);
    updateVal(`val-powerdc1-${r._sn}`, cellMeasured(r.powerdc1, FIELD_UNITS.powerdc1), r.powerdc1);
    updateVal(`val-powerdc2-${r._sn}`, cellMeasured(r.powerdc2, FIELD_UNITS.powerdc2), r.powerdc2);
  });
}

/** Mise à jour légère : uniquement le timer global (chaque seconde) */
function updateTimerBadges() {
  if (!globalData || globalData.length === 0) return;

  const maxTs = Math.max(...globalData.filter(d => d._cacheTimestamp).map(d => d._cacheTimestamp));
  const ageMs = Date.now() - maxTs;
  const isLive = ageMs < 5000;

  const timerEl = document.getElementById("sum-cache-timer");
  if (timerEl) {
    const timerParent = timerEl.closest(".summary-chip");
    if (timerParent) {
      if (isLive) timerParent.classList.add("is-live");
      else timerParent.classList.remove("is-live");
    }

    if (isLive) {
      timerEl.innerHTML = `<span class="status-dot pulse"></span><span class="summary-num">Direct</span>`;
    } else {
      const ageSec = Math.floor(ageMs / 1000);
      const min = Math.floor(ageSec / 60);
      const sec = ageSec % 60;
      timerEl.innerHTML = `<span class="summary-num">${min > 0 ? min + "m " : ""}${sec}</span><span class="summary-unit">s</span>`;
    }
  }

  // Mettre à jour l'horloge
  const timeEl = document.getElementById("time");
  if (timeEl && !timeEl.classList.contains("is-error")) {
    timeEl.textContent = "🕐 " + new Date().toLocaleString();
  }
}

/* ——— SSE : Connexion temps réel au serveur ——— */
let eventSource = null;
let reconnectTimer = null;

function connectSSE() {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource("/api/events");

  eventSource.addEventListener("pv", (e) => {
    try {
      globalData = JSON.parse(e.data);
      if (isLocal) console.log("SSE PV:", globalData);

      const timeEl = document.getElementById("time");
      timeEl.classList.remove("is-error");
      timeEl.textContent = "🕐 " + new Date().toLocaleString();

      renderDOM();
    } catch (err) {
      console.error("Erreur parsing SSE pv:", err);
    }
  });

  eventSource.addEventListener("history", (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data && data.days) {
        serverHistory = data;
        applyChartView();
      }
    } catch (err) {
      console.error("Erreur parsing SSE history:", err);
    }
  });

  eventSource.onerror = () => {
    console.warn("SSE connexion perdue, reconnexion dans 5s...");
    eventSource.close();
    const timeEl = document.getElementById("time");
    if (timeEl) {
      timeEl.textContent = "⚠️ Connexion perdue — reconnexion...";
      timeEl.classList.add("is-error");
    }
    // Reconnexion automatique avec backoff
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSSE, 5000);
  };
}

/* ——— Bouton Rafraîchir (force un fetch REST ponctuel en parallèle) ——— */
async function manualRefresh() {
  const btnRefresh = document.getElementById("btnRefresh");
  if (btnRefresh) {
    btnRefresh.disabled = true;
    btnRefresh.setAttribute("aria-busy", "true");
  }

  try {
    const res = await fetch("/api/pv?t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    globalData = await res.json();
    renderDOM();
  } catch (e) {
    console.error("Erreur refresh manuel:", e);
  } finally {
    if (btnRefresh) {
      btnRefresh.disabled = false;
      btnRefresh.removeAttribute("aria-busy");
    }
  }
}

/* ——— Chargement initial REST (filet de sécurité si SSE met du temps) ——— */
async function initialLoad() {
  try {
    const [pvRes, histRes] = await Promise.all([
      fetch("/api/pv?t=" + Date.now()),
      fetch("/api/history?t=" + Date.now())
    ]);

    if (pvRes.ok) {
      globalData = await pvRes.json();
      const timeEl = document.getElementById("time");
      timeEl.classList.remove("is-error");
      timeEl.textContent = "🕐 " + new Date().toLocaleString();
      renderDOM();
    }

    if (histRes.ok) {
      const histData = await histRes.json();
      if (histData && histData.days) {
        serverHistory = histData;
        applyChartView();
      }
    }
  } catch (e) {
    console.error("Erreur chargement initial:", e);
  }
}

/* ——— Polling REST de secours (garantit la fraîcheur même si SSE est cassé) ——— */
async function fallbackPoll() {
  try {
    const res = await fetch("/api/pv?t=" + Date.now());
    if (!res.ok) return;
    globalData = await res.json();
    const timeEl = document.getElementById("time");
    if (timeEl) {
      timeEl.classList.remove("is-error");
      timeEl.textContent = "🕐 " + new Date().toLocaleString();
    }
    renderDOM();
  } catch { /* silencieux */ }
}

async function fallbackHistoryPoll() {
  try {
    const res = await fetch("/api/history?t=" + Date.now());
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.days) {
      serverHistory = data;
      applyChartView();
    }
  } catch { /* silencieux */ }
}

/* ——— Au chargement ——— */
document.addEventListener("DOMContentLoaded", () => {
  initPowerChart();

  document.getElementById("btnRefresh").addEventListener("click", manualRefresh);

  // 1. Fetch REST immédiat pour afficher les données sans attendre
  initialLoad();

  // 2. Connecter le flux SSE pour les mises à jour en temps réel
  connectSSE();

  // 3. Mise à jour légère des timers chaque seconde
  setInterval(updateTimerBadges, 1000);

  // 4. Polling REST de secours toutes les 10s (filet de sécurité si SSE est bloqué)
  setInterval(fallbackPoll, 10000);
  setInterval(fallbackHistoryPoll, 65000);
});
