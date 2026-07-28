"use strict";

/* ================================================================
   CONSTANTES & ÉTAT
   ================================================================ */
const today = getLocalDayKey();

let statsData     = null;   // { days, totals, readings }
let statsChart    = null;
let batteryChart  = null;
let activePreset  = "30";

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
function runBatterySimulation() {
  if (!statsData || !statsData.readings || statsData.readings.length === 0) {
    showToast("⚠️ Pas de données brutes disponibles pour la simulation.", "error");
    return;
  }

  const voltage    = parseFloat(document.getElementById("bat-voltage").value);
  const dod        = parseFloat(document.getElementById("bat-dod").value);
  const efficiency = parseFloat(document.getElementById("bat-efficiency").value);

  document.getElementById("battery-result").style.display  = "none";
  document.getElementById("battery-loading").style.display = "flex";

  // On lance la simulation dans un micro-délai pour laisser l'UI se mettre à jour
  setTimeout(() => {
    try {
      const result = computeBatteryScenarios(statsData.readings, voltage, dod, efficiency);
      renderBatteryResult(result, voltage, dod);
    } catch (err) {
      console.error("Erreur simulation batterie:", err);
      showToast("❌ Erreur lors de la simulation.", "error");
    } finally {
      document.getElementById("battery-loading").style.display = "none";
    }
  }, 50);
}

/**
 * Simule plusieurs capacités de batterie sur les données brutes.
 * @param {Array}  readings   power_readings (ts, pv_power, house_power, grid_power)
 * @param {number} voltage    Tension batterie (V)
 * @param {number} dod        Profondeur de décharge (0–1)
 * @param {number} efficiency Rendement aller-retour (0–1)
 * @returns {object}
 */
function computeBatteryScenarios(readings, voltage, dod, efficiency) {
  // Trier par timestamp
  const pts = [...readings].sort((a, b) => a.ts - b.ts);

  // --- Baseline (sans batterie) ---
  let baseYield = 0, baseHouse = 0, baseSolarUsed = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].ts - pts[i - 1].ts) / 3_600_000;
    if (dt <= 0 || dt > 0.5) continue;
    const avgPv    = (pts[i].pv_power    + pts[i - 1].pv_power)    / 2;
    const avgHouse = (pts[i].house_power + pts[i - 1].house_power) / 2;
    const pv    = Math.max(0, avgPv);
    const house = Math.max(0, avgHouse);
    baseYield     += pv    * dt / 1000;
    baseHouse     += house * dt / 1000;
    baseSolarUsed += Math.min(pv, house) * dt / 1000;
  }

  const baseAC  = baseYield > 0 ? baseSolarUsed / baseYield  : 0;
  const baseInd = baseHouse > 0 ? baseSolarUsed / baseHouse  : 0;

  if (baseHouse < 0.1) {
    // Pas de données de consommation
    return { error: "Données de consommation maison insuffisantes pour la simulation." };
  }

  // --- Simulation sur une plage de capacités ---
  // De 0.5 à 20 kWh par pas de 0.5 kWh
  const capacitiesKwh = [];
  for (let c = 0.5; c <= 20.01; c += 0.5) capacitiesKwh.push(Math.round(c * 10) / 10);

  const results = capacitiesKwh.map(capKwh => simulateCapacity(pts, capKwh, dod, efficiency, baseHouse, baseYield, baseInd));

  // Trouver la capacité optimale (coude : gain marginal < 1.5 % par kWh supplémentaire)
  let optimalIdx = results.length - 1;
  for (let i = 1; i < results.length; i++) {
    const marginalGain = (results[i].indPct - results[i - 1].indPct); // en %
    // Gain par kWh ajouté
    if (marginalGain < 1.5) {
      optimalIdx = i - 1;
      break;
    }
  }

  // Scénarios fixes pour le tableau
  const fixedCapacities = [0, 2, 5, 10, 15, 20];
  const scenarios = fixedCapacities.map(cap => {
    if (cap === 0) return { capKwh: 0, capAh: 0, indPct: round1(baseInd * 100), gainPct: 0, acPct: round1(baseAC * 100), isBaseline: true };
    const r = simulateCapacity(pts, cap, dod, efficiency, baseHouse, baseYield, baseInd);
    return { ...r, capKwh: cap, capAh: Math.round((cap * 1000) / (voltage * dod)), isBaseline: false };
  });

  // Ajouter l'optimal si pas déjà dans la liste
  const optCap = capacitiesKwh[optimalIdx];
  const optResult = results[optimalIdx];

  return {
    baseline: { indPct: round1(baseInd * 100), acPct: round1(baseAC * 100) },
    capacitiesKwh,
    results,
    optimal: {
      capKwh: optCap,
      capAh: Math.round((optCap * 1000) / (voltage * dod)),
      indPct: optResult.indPct,
      gainPct: optResult.gainPct,
      acPct: optResult.acPct,
    },
    scenarios,
  };
}

function simulateCapacity(pts, capKwh, dod, efficiency, baseHouse, baseYield, baseInd) {
  const usableKwh = capKwh * dod;
  let soc = 0;           // kWh actuellement stockés
  let extraSolar = 0;    // kWh supplémentaires fournis par la batterie

  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].ts - pts[i - 1].ts) / 3_600_000;
    if (dt <= 0 || dt > 0.5) continue;
    const avgPv    = (pts[i].pv_power    + pts[i - 1].pv_power)    / 2;
    const avgHouse = (pts[i].house_power + pts[i - 1].house_power) / 2;
    const pv    = Math.max(0, avgPv);
    const house = Math.max(0, avgHouse);
    const surplus = (pv - house) * dt / 1000; // kWh

    if (surplus > 0) {
      // Charger la batterie (avec perte de rendement)
      const canCharge = Math.min(surplus * Math.sqrt(efficiency), usableKwh - soc);
      soc += Math.max(0, canCharge);
    } else {
      // Décharger la batterie pour couvrir le déficit
      const needed  = -surplus;
      const canDischarge = Math.min(needed, soc * Math.sqrt(efficiency));
      soc -= canDischarge / Math.sqrt(efficiency);
      soc = Math.max(0, soc);
      extraSolar += canDischarge;
    }
  }

  const newSolarUsed = (baseHouse > 0 ? baseInd * baseHouse : 0) + extraSolar;
  const newInd = baseHouse > 0 ? Math.min(1, newSolarUsed / baseHouse) : 0;
  const newAC  = baseYield > 0 ? Math.min(1, (baseYield > 0 ? baseInd * baseHouse / baseYield : 0) + extraSolar / baseYield) : 0;

  // Recalcul auto-conso propre
  const baseSolarUsed = baseHouse > 0 ? baseInd * baseHouse : 0;
  const newAC2 = baseYield > 0 ? Math.min(1, (baseSolarUsed + extraSolar) / baseYield) : 0;

  return {
    indPct:  round1(newInd  * 100),
    gainPct: round1((newInd - baseInd) * 100),
    acPct:   round1(newAC2  * 100),
  };
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
