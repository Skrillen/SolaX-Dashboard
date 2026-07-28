"use strict";

/* ================================================================
   CONSTANTES & ÉTAT
   ================================================================ */
const today = getLocalDayKey();

let statsData     = null;   // { days, totals }
let statsChart    = null;
let batteryChart  = null;
let activePreset  = "30";
let currentFromDate = "";
let currentToDate   = "";

/* ================================================================
   UTILITAIRES DATE
   ================================================================ */
function getLocalDayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function subtractDays(dayKey, n) {
  const [y, m, d] = dayKey.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - n);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,"0")}-${String(dt.getDate()).padStart(2,"0")}`;
}

function formatDate(dayKey) {
  const [y, m, d] = dayKey.split("-");
  return `${d}/${m}/${y}`;
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

/* ================================================================
   TOAST
   ================================================================ */
let _toastTimer = null;
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  if (!el) return;
  if (_toastTimer) clearTimeout(_toastTimer);
  el.textContent = msg;
  el.className = `toast is-visible${type ? " is-" + type : ""}`;
  _toastTimer = setTimeout(() => el.classList.remove("is-visible"), 3500);
}

/* ================================================================
   CHARGEMENT DES DONNÉES
   ================================================================ */
async function loadStats(fromDate, toDate) {
  currentFromDate = fromDate;
  currentToDate   = toDate;
  showState("loading");
  try {
    const res = await fetch(`/api/db/stats?from=${fromDate}&to=${toDate}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    statsData = await res.json();
    renderStats(fromDate, toDate);
    showState("content");
  } catch (err) {
    console.error("Erreur chargement stats:", err);
    document.getElementById("stats-error-msg").textContent = `Erreur : ${err.message}`;
    showState("error");
  }
}

function showState(state) {
  document.getElementById("stats-loading").style.display = state === "loading" ? "flex" : "none";
  document.getElementById("stats-content").style.display  = state === "content" ? "block" : "none";
  document.getElementById("stats-error").style.display    = state === "error"   ? "flex" : "none";
}

/* ================================================================
   RENDU DES STATISTIQUES
   ================================================================ */
function renderStats(fromDate, toDate) {
  if (!statsData) return;
  const { totals, days } = statsData;

  // Info période
  const infoEl = document.getElementById("stats-period-info");
  if (infoEl) {
    infoEl.textContent = `Période : ${formatDate(fromDate)} → ${formatDate(toDate)} · ${totals.dayCount} jour${totals.dayCount > 1 ? "s" : ""} de données`;
  }

  // KPIs énergie
  const kpiEnergy = document.getElementById("kpi-energy");
  if (kpiEnergy) {
    kpiEnergy.innerHTML = [
      kpiCard("⚡", "Production totale",       totals.yieldKwh,     "kWh", "var(--accent-primary)"),
      kpiCard("🏠", "Conso. Maison totale",    totals.houseKwh,     "kWh", "var(--accent-warning)"),
      kpiCard("☀️", "Solaire autoconsommé",   totals.solarUsedKwh, "kWh", "var(--accent-success)"),
      kpiCard("📥", "Import réseau total",     totals.importKwh,    "kWh", "#60a5fa"),
      kpiCard("📤", "Export réseau total",     totals.exportKwh,    "kWh", "#a78bfa"),
    ].join("");
  }

  // KPIs ratios
  const kpiRatios = document.getElementById("kpi-ratios");
  if (kpiRatios) {
    const ac = totals.autoConso;
    const ind = totals.independence;
    kpiRatios.innerHTML = [
      kpiMinAvgMax("🔄", "Auto-consommation", ac, "%",  "var(--accent-success)"),
      kpiMinAvgMax("🛡️", "Indépendance",     ind, "%", "var(--accent-primary)"),
    ].join("");
  }

  // Graphique
  renderStatsChart(days);

  // Réinitialiser le résultat batterie si données changent
  document.getElementById("battery-result").style.display  = "none";
  document.getElementById("battery-loading").style.display = "none";
}

function kpiCard(icon, label, value, unit, color) {
  const display = value != null ? `<span class="kpi-num" style="color:${color}">${round2(value)}</span><span class="kpi-unit">${unit}</span>` : `<span class="kpi-na">—</span>`;
  return `<div class="stats-kpi-card">
    <div class="kpi-icon">${icon}</div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${display}</div>
  </div>`;
}

function kpiMinAvgMax(icon, label, obj, unit, color) {
  if (!obj || obj.avg == null) {
    return `<div class="stats-kpi-card stats-kpi-card--wide">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value"><span class="kpi-na">Données insuffisantes</span></div>
    </div>`;
  }
  return `<div class="stats-kpi-card stats-kpi-card--wide">
    <div class="kpi-icon">${icon}</div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-mma">
      <div class="kpi-mma-item">
        <span class="kpi-mma-label">MIN</span>
        <span class="kpi-mma-value" style="color:var(--accent-danger)">${obj.min}${unit}</span>
      </div>
      <div class="kpi-mma-item kpi-mma-avg">
        <span class="kpi-mma-label">MOY</span>
        <span class="kpi-mma-value" style="color:${color};font-size:1.6em">${obj.avg}${unit}</span>
      </div>
      <div class="kpi-mma-item">
        <span class="kpi-mma-label">MAX</span>
        <span class="kpi-mma-value" style="color:var(--accent-success)">${obj.max}${unit}</span>
      </div>
    </div>
  </div>`;
}

/* ================================================================
   GRAPHIQUE JOURNALIER
   ================================================================ */
function renderStatsChart(days) {
  const canvas = document.getElementById("statsChart");
  if (!canvas || typeof Chart === "undefined") return;

  // Limiter l'affichage à 90 jours max (éviter illisibilité)
  const displayDays = days.length > 90 ? days.slice(-90) : days;

  const labels     = displayDays.map(d => formatDate(d.dayKey));
  const dsYield    = displayDays.map(d => round2(d.yieldKwh));
  const dsHouse    = displayDays.map(d => round2(d.houseKwh));
  const dsAC       = displayDays.map(d => d.autoConso    != null ? round1(d.autoConso    * 100) : null);
  const dsInd      = displayDays.map(d => d.independence != null ? round1(d.independence * 100) : null);

  const TC = "#888", GC = "rgba(255,255,255,0.06)";

  if (statsChart) statsChart.destroy();

  statsChart = new Chart(canvas.getContext("2d"), {
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Production (kWh)",
          data: dsYield,
          backgroundColor: "rgba(255,90,90,0.55)",
          borderColor: "#ff5a5a",
          borderWidth: 1,
          borderRadius: 3,
          yAxisID: "yKwh",
          order: 2,
        },
        {
          type: "bar",
          label: "Conso. Maison (kWh)",
          data: dsHouse,
          backgroundColor: "rgba(59,130,246,0.45)",
          borderColor: "#3b82f6",
          borderWidth: 1,
          borderRadius: 3,
          yAxisID: "yKwh",
          order: 2,
        },
        {
          type: "line",
          label: "Auto-conso (%)",
          data: dsAC,
          borderColor: "#22c55e",
          backgroundColor: "transparent",
          borderWidth: 2,
          pointRadius: displayDays.length > 30 ? 0 : 3,
          pointHoverRadius: 5,
          tension: 0.3,
          yAxisID: "yPct",
          order: 1,
          spanGaps: true,
        },
        {
          type: "line",
          label: "Indépendance (%)",
          data: dsInd,
          borderColor: "#a855f7",
          backgroundColor: "transparent",
          borderWidth: 2,
          pointRadius: displayDays.length > 30 ? 0 : 3,
          pointHoverRadius: 5,
          tension: 0.3,
          yAxisID: "yPct",
          order: 1,
          spanGaps: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      scales: {
        x: {
          grid: { color: GC },
          ticks: { color: TC, maxRotation: 45, autoSkip: true, maxTicksLimit: displayDays.length > 30 ? 12 : 30 },
        },
        yKwh: {
          position: "left",
          min: 0,
          title: { display: true, text: "kWh", color: TC },
          grid: { color: GC },
          ticks: { color: TC },
        },
        yPct: {
          position: "right",
          min: 0, max: 100,
          title: { display: true, text: "%", color: TC },
          grid: { drawOnChartArea: false },
          ticks: { color: TC, callback: v => v + "%" },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "rgba(10,10,10,0.92)",
          titleColor: "#f0f0f0",
          bodyColor: "#ccc",
          borderColor: "#333",
          borderWidth: 1,
          callbacks: {
            label(ctx) {
              const v = ctx.parsed.y;
              if (v == null) return null;
              const unit = ctx.dataset.yAxisID === "yPct" ? "%" : " kWh";
              return `${ctx.dataset.label}: ${round1(v)}${unit}`;
            },
          },
        },
      },
    },
  });
}

/* ================================================================
   SIMULATION BATTERIE
   ================================================================ */
async function runBatterySimulation() {
  const from = document.getElementById("stats-from").value || currentFromDate;
  const to   = document.getElementById("stats-to").value   || currentToDate;

  if (!from || !to) {
    showToast("⚠️ Période non définie.", "error");
    return;
  }

  const voltage    = parseFloat(document.getElementById("bat-voltage").value);
  const dod        = parseFloat(document.getElementById("bat-dod").value);
  const efficiency = parseFloat(document.getElementById("bat-efficiency").value);

  document.getElementById("battery-result").style.display  = "none";
  document.getElementById("battery-loading").style.display = "flex";

  try {
    const res = await fetch(`/api/db/battery-sim?from=${from}&to=${to}&voltage=${voltage}&dod=${dod}&efficiency=${efficiency}`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    const result = await res.json();
    renderBatteryResult(result, voltage, dod);
  } catch (err) {
    console.error("Erreur simulation batterie:", err);
    showToast("❌ Erreur lors de la simulation.", "error");
  } finally {
    document.getElementById("battery-loading").style.display = "none";
  }
}

/* ================================================================
   RENDU RÉSULTAT BATTERIE
   ================================================================ */
function renderBatteryResult(result, voltage, dod) {
  if (result.error) {
    showToast("⚠️ " + result.error, "error");
    return;
  }

  const { baseline, optimal, capacitiesKwh, results, scenarios } = result;

  // Carte optimale
  document.getElementById("bat-optimal-value").textContent =
    `${optimal.capAh} Ah  (${optimal.capKwh} kWh)`;
  document.getElementById("bat-optimal-sub").textContent =
    `Indépendance estimée : ${optimal.indPct}%  (+${optimal.gainPct}% vs. sans batterie)`;

  // Courbe gain
  renderBatteryChart(baseline, capacitiesKwh, results);

  // Tableau scénarios
  const tbody = document.getElementById("bat-scenarios-body");
  const optCapKwh = optimal.capKwh;
  tbody.innerHTML = scenarios.map(s => {
    const isOpt = !s.isBaseline && s.capKwh === optCapKwh;
    const cls   = s.isBaseline ? "" : (isOpt ? "bat-row-optimal" : "");
    const label = s.isBaseline ? "Sans batterie" : `${s.capKwh} kWh`;
    const ahStr = s.isBaseline ? "—" : `${s.capAh} Ah`;
    const gainStr = s.isBaseline ? "—" : `+${s.gainPct} %`;
    const optBadge = isOpt ? ` <span class="bat-opt-badge">✦ Optimal</span>` : "";
    return `<tr class="${cls}">
      <td>${label}${optBadge}</td>
      <td>${ahStr}</td>
      <td>${s.indPct} %</td>
      <td>${gainStr}</td>
      <td>${s.acPct} %</td>
    </tr>`;
  }).join("");

  document.getElementById("battery-result").style.display = "block";
}

function renderBatteryChart(baseline, capacitiesKwh, results) {
  const canvas = document.getElementById("batteryChart");
  if (!canvas || typeof Chart === "undefined") return;

  if (batteryChart) batteryChart.destroy();

  const TC = "#888", GC = "rgba(255,255,255,0.06)";

  batteryChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: {
      labels: ["0 kWh (sans)", ...capacitiesKwh.map(c => c + " kWh")],
      datasets: [
        {
          label: "Indépendance (%)",
          data: [baseline.indPct, ...results.map(r => r.indPct)],
          borderColor: "#a855f7",
          backgroundColor: "rgba(168,85,247,0.08)",
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 5,
          yAxisID: "yPct",
        },
        {
          label: "Gain vs. sans batterie (%)",
          data: [0, ...results.map(r => r.gainPct)],
          borderColor: "#22c55e",
          backgroundColor: "transparent",
          borderWidth: 2,
          borderDash: [5, 4],
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 5,
          yAxisID: "yPct",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      scales: {
        x: {
          grid: { color: GC },
          ticks: { color: TC, maxTicksLimit: 12, autoSkip: true },
        },
        yPct: {
          position: "left",
          min: 0,
          title: { display: true, text: "%", color: TC },
          grid: { color: GC },
          ticks: { color: TC, callback: v => v + "%" },
        },
      },
      plugins: {
        legend: { display: true, labels: { color: "#ccc", boxWidth: 14, padding: 12 } },
        tooltip: {
          backgroundColor: "rgba(10,10,10,0.92)",
          titleColor: "#f0f0f0",
          bodyColor: "#ccc",
          borderColor: "#333",
          borderWidth: 1,
          callbacks: {
            label(ctx) { return `${ctx.dataset.label}: ${ctx.parsed.y} %`; },
          },
        },
      },
    },
  });
}

/* ================================================================
   SÉLECTEUR DE PÉRIODE
   ================================================================ */
function applyPreset(preset) {
  activePreset = preset;
  const fromInput = document.getElementById("stats-from");
  const toInput   = document.getElementById("stats-to");

  // Mettre à jour les classes actives
  document.querySelectorAll(".period-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.preset === String(preset));
  });

  const toDate = today;
  let fromDate;

  if (preset === "all") {
    fromDate = "2020-01-01"; // Suffisamment loin pour tout couvrir
  } else {
    fromDate = subtractDays(today, parseInt(preset) - 1);
  }

  if (fromInput) fromInput.value = fromDate;
  if (toInput)   toInput.value   = toDate;

  loadStats(fromDate, toDate);
}

function applyCustomRange() {
  const from = document.getElementById("stats-from").value;
  const to   = document.getElementById("stats-to").value;

  if (!from || !to) {
    showToast("⚠️ Sélectionne une date de début et de fin.", "error");
    return;
  }
  if (from > to) {
    showToast("⚠️ La date de début doit être avant la date de fin.", "error");
    return;
  }
  if (to > today) {
    showToast("⚠️ La date de fin ne peut pas être dans le futur.", "error");
    return;
  }

  // Désactiver les presets
  document.querySelectorAll(".period-btn").forEach(btn => btn.classList.remove("active"));
  activePreset = null;

  loadStats(from, to);
}

/* ================================================================
   INIT
   ================================================================ */
document.addEventListener("DOMContentLoaded", () => {
  // Initialiser les inputs date
  const fromInput = document.getElementById("stats-from");
  const toInput   = document.getElementById("stats-to");
  if (fromInput) fromInput.max = today;
  if (toInput)   toInput.max  = today;

  // Boutons preset
  document.querySelectorAll(".period-btn").forEach(btn => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });

  // Bouton appliquer
  document.getElementById("stats-apply")?.addEventListener("click", applyCustomRange);

  // Bouton retry
  document.getElementById("stats-retry")?.addEventListener("click", () => {
    const from = document.getElementById("stats-from").value || subtractDays(today, 29);
    const to   = document.getElementById("stats-to").value   || today;
    loadStats(from, to);
  });

  // Bouton simulation batterie
  document.getElementById("bat-simulate")?.addEventListener("click", runBatterySimulation);

  // Appliquer le preset par défaut (30 jours)
  applyPreset("30");

  // Hors-ligne
  window.addEventListener("offline", () => document.body.classList.add("is-offline"));
  window.addEventListener("online",  () => document.body.classList.remove("is-offline"));
  if (!navigator.onLine) document.body.classList.add("is-offline");
});
