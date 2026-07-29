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
    const ptsStr = totals.readingCount ? `${totals.readingCount.toLocaleString("fr-FR")} points sur ` : "";
    infoEl.textContent = `Période : ${formatDate(fromDate)} → ${formatDate(toDate)} · ${ptsStr}${totals.dayCount} jour${totals.dayCount > 1 ? "s" : ""} analysé${totals.dayCount > 1 ? "s" : ""}`;
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
    return `<div class="stats-kpi-card">
      <div class="kpi-icon">${icon}</div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-value"><span class="kpi-na">Données insuffisantes</span></div>
    </div>`;
  }
  return `<div class="stats-kpi-card">
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

  const voltage      = parseFloat(document.getElementById("bat-voltage").value);
  const dod          = parseFloat(document.getElementById("bat-dod").value);
  const efficiency   = parseFloat(document.getElementById("bat-efficiency").value);
  const priceImport  = parseFloat(document.getElementById("bat-price-import")?.value) || 0.20;
  const priceSurplus = parseFloat(document.getElementById("bat-price-surplus")?.value) || 0.04;

  saveBatteryParams(voltage, dod, efficiency, priceImport, priceSurplus);

  document.getElementById("battery-result").style.display  = "none";
  document.getElementById("battery-loading").style.display = "flex";

  try {
    const res = await fetch(`/api/db/battery-sim?from=${from}&to=${to}&voltage=${voltage}&dod=${dod}&efficiency=${efficiency}&priceImport=${priceImport}&priceSurplus=${priceSurplus}`);
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

  const { baseline, recommended, usefulLimit, capacitiesKwh, results, scenarios } = result;

  // 1) Carte Batterie Recommandée
  document.getElementById("bat-rec-value").textContent =
    `${recommended.capKwh} kWh (${recommended.capAh} Ah)`;

  document.getElementById("bat-rec-list").innerHTML = [
    `<li>• <strong>${recommended.surplusCapturedPct}%</strong> du surplus utile capturé</li>`,
    `<li>• <strong>${recommended.indPct}%</strong> d'indépendance globale</li>`,
    `<li>• Seulement <strong>${recommended.exportRemKwh} kWh</strong> d'export restant sur la période</li>`,
    `<li>• Batterie remplie à <strong>${recommended.capacityUtilizationPct}%</strong> en moyenne par jour (~${recommended.estimatedSavingsEur} € économisés)</li>`,
  ].join("");

  // 2) Carte Limite Utile
  document.getElementById("bat-limit-value").textContent =
    `Au-delà de ${usefulLimit.capKwh} kWh (${usefulLimit.capAh} Ah)`;

  document.getElementById("bat-limit-desc").textContent =
    `Au-delà de cette capacité, le remplissage moyen quotidien chute et les kWh supplémentaires apportent un gain négligeable.`;

  // Courbe gain
  renderBatteryChart(baseline, capacitiesKwh, results);

  // Tableau scénarios
  const tbody = document.getElementById("bat-scenarios-body");
  const recCapKwh   = recommended.capKwh;
  const limitCapKwh = usefulLimit.capKwh;

  tbody.innerHTML = scenarios.map(s => {
    const isRec   = !s.isBaseline && (s.isRecommended || s.capKwh === recCapKwh);
    const isLimit = !s.isBaseline && (s.isUsefulLimit  || s.capKwh === limitCapKwh) && s.capKwh !== recCapKwh;
    
    let cls = "";
    if (isRec) cls = "bat-row-optimal";
    else if (isLimit) cls = "bat-row-maxind";

    const label      = s.isBaseline ? "Sans batterie" : `${s.capKwh} kWh`;
    const ahStr      = s.isBaseline ? "—" : `${s.capAh} Ah`;
    const cycledStr  = s.isBaseline ? "—" : `${s.cycledKwh} kWh`;
    const surplusStr = s.isBaseline ? "—" : `${s.surplusCapturedPct} %`;
    const utilStr    = s.isBaseline ? "—" : `${s.capacityUtilizationPct} %`;
    const savingsStr = s.isBaseline ? "—" : `+${s.estimatedSavingsEur} €`;
    const expStr     = `${s.exportRemKwh} kWh`;

    let badges = "";
    if (isRec) badges += ` <span class="bat-opt-badge bat-badge-rec" title="Batterie recommandée">🔋 Recommandée</span>`;
    if (isLimit) badges += ` <span class="bat-opt-badge bat-badge-warn" title="Limite utile">⚠️ Limite</span>`;

    return `<tr class="${cls}">
      <td>${label}${badges}</td>
      <td>${ahStr}</td>
      <td><strong>${s.acPct} %</strong></td>
      <td>${s.indPct} %</td>
      <td><strong>${savingsStr}</strong></td>
      <td>${expStr}</td>
      <td>${cycledStr}</td>
      <td><strong>${surplusStr}</strong></td>
      <td>${utilStr}</td>
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
          label: "Auto-consommation (%)",
          data: [baseline.acPct, ...results.map(r => r.acPct)],
          borderColor: "#22c55e",
          backgroundColor: "rgba(34,197,94,0.08)",
          borderWidth: 2.5,
          fill: true,
          tension: 0.4,
          pointRadius: 0,
          pointHoverRadius: 5,
          yAxisID: "yPct",
        },
        {
          label: "Indépendance (%)",
          data: [baseline.indPct, ...results.map(r => r.indPct)],
          borderColor: "#a855f7",
          backgroundColor: "transparent",
          borderWidth: 2,
          borderDash: [4, 4],
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
   PERSISTANCE DES PARAMÈTRES BATTERIE (localStorage)
   ================================================================ */
function loadBatteryParams() {
  try {
    const saved = localStorage.getItem("solax_battery_params");
    if (!saved) return;
    const p = JSON.parse(saved);
    if (p.voltage && document.getElementById("bat-voltage"))      document.getElementById("bat-voltage").value    = p.voltage;
    if (p.dod && document.getElementById("bat-dod"))              document.getElementById("bat-dod").value        = p.dod;
    if (p.efficiency && document.getElementById("bat-efficiency"))   document.getElementById("bat-efficiency").value = p.efficiency;
    if (p.priceImport && document.getElementById("bat-price-import")) document.getElementById("bat-price-import").value = p.priceImport;
    if (p.priceSurplus && document.getElementById("bat-price-surplus")) document.getElementById("bat-price-surplus").value = p.priceSurplus;
  } catch (e) {
    console.warn("Impossible de charger les paramètres batterie depuis localStorage", e);
  }
}

function saveBatteryParams(voltage, dod, efficiency, priceImport, priceSurplus) {
  try {
    localStorage.setItem("solax_battery_params", JSON.stringify({ voltage, dod, efficiency, priceImport, priceSurplus }));
  } catch (e) {
    console.warn("Impossible de sauvegarder les paramètres batterie dans localStorage", e);
  }
}

/* ================================================================
   INIT
   ================================================================ */
document.addEventListener("DOMContentLoaded", () => {
  // Restaurer les paramètres batterie sauvegardés
  loadBatteryParams();

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
