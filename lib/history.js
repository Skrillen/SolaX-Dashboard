"use strict";

const { HISTORY_RETENTION_DAYS, wifiSns } = require("./config");
const db = require("./database");

/* --------------------------------------------------------------------------
   État en RAM
   (conservé pour le push SSE — fenêtre glissante des derniers jours)
   -------------------------------------------------------------------------- */
let history = { version: 2, days: {}, summaries: {} };

/* --------------------------------------------------------------------------
   Restauration depuis SQLite au démarrage
   On recharge les 7 derniers jours en RAM pour alimenter le SSE sans attendre
   que les polls repeuplent l'objet.
   -------------------------------------------------------------------------- */
function loadHistoryFromDisk() {
  try {
    // Récupérer les points des HISTORY_RETENTION_DAYS derniers jours depuis SQLite
    const cutoff = Date.now() - HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const rows = db.getPowerReadingsRange(cutoff, Date.now());

    for (const row of rows) {
      if (!history.days[row.day_key]) history.days[row.day_key] = [];
      history.days[row.day_key].push([
        row.ts,
        row.pv_power,
        row.house_power,
        row.grid_power,
      ]);
    }

    // Récupérer les bilans journaliers récents
    const summaries = db.getDailySummaries(HISTORY_RETENTION_DAYS);
    for (const s of summaries) {
      history.summaries[s.day_key] = {
        yield:     s.yield_kwh,
        import:    s.import_kwh,
        export:    s.export_kwh,
        updatedAt: s.updated_at,
      };
    }

    const dayCount = Object.keys(history.days).length;
    const pointCount = rows.length;
    console.log(`[history] 📦 Historique restauré depuis SQLite : ${pointCount} points sur ${dayCount} jour(s).`);
  } catch (err) {
    console.warn("[history] Impossible de restaurer depuis SQLite :", err.message);
  }
}

/* --------------------------------------------------------------------------
   Clé de jour locale
   -------------------------------------------------------------------------- */
function getLocalDayKey() {
  // en-CA formatte les dates en YYYY-MM-DD nativement.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  }).format(new Date());
}

/* --------------------------------------------------------------------------
   Nettoyage des jours trop anciens en RAM (fenêtre glissante)
   SQLite, lui, garde tout sans limite.
   -------------------------------------------------------------------------- */
function pruneHistoryDays() {
  const keys = Object.keys(history.days).sort();
  if (keys.length > HISTORY_RETENTION_DAYS) {
    const toRemove = keys.slice(0, keys.length - HISTORY_RETENTION_DAYS);
    for (const k of toRemove) delete history.days[k];
  }
}

/* --------------------------------------------------------------------------
   Enregistrement d'un point de puissance
   cache est injecté depuis solax.js pour éviter les dépendances circulaires.
   -------------------------------------------------------------------------- */
function recordHistoryPoint(cache, forcedValue = null) {
  const now = Date.now();
  let totalPower = 0;

  if (forcedValue !== null) {
    totalPower = forcedValue;
  } else {
    for (const sn of wifiSns) {
      const entry = cache[sn];
      if (entry?.data?.acpower && now - entry.timestamp < 5 * 60_000) {
        totalPower += Math.max(0, parseFloat(entry.data.acpower) || 0);
      }
    }
  }

  let gridPower = 0;
  const meterEntry = cache["meter"];
  if (meterEntry?.data && now - meterEntry.timestamp < 5 * 60_000) {
    gridPower = meterEntry.data.totalActivePower || 0;
  }
  const housePower = Math.max(0, totalPower - gridPower);

  const pvR   = Math.round(totalPower * 100) / 100;
  const houseR = Math.round(housePower * 100) / 100;
  const gridR  = Math.round(gridPower  * 100) / 100;

  // Mise à jour de la fenêtre RAM (pour le SSE)
  const todayKey = getLocalDayKey();
  if (!history.days[todayKey]) history.days[todayKey] = [];
  history.days[todayKey].push([now, pvR, houseR, gridR]);

  // Persistance SQLite (source de vérité durable)
  try {
    db.insertPowerReading(now, todayKey, pvR, houseR, gridR);
  } catch (err) {
    console.warn("[history] Erreur écriture SQLite (power_readings) :", err.message);
  }

  console.log(`[${new Date().toLocaleTimeString()}] 📈 Point historique : PV=${Math.round(totalPower)}W | Maison=${Math.round(housePower)}W`);
  pruneHistoryDays();
}

/* --------------------------------------------------------------------------
   Enregistrement du bilan final d'une journée (kWh)
   -------------------------------------------------------------------------- */
function recordDailySummary(dayKey, data) {
  if (!history.summaries) history.summaries = {};
  history.summaries[dayKey] = {
    yield:     Math.round(data.yield  * 100) / 100,
    import:    Math.round(data.import * 100) / 100,
    export:    Math.round(data.export * 100) / 100,
    updatedAt: Date.now(),
  };

  // Persistance SQLite
  try {
    db.upsertDailySummary(
      dayKey,
      history.summaries[dayKey].yield,
      history.summaries[dayKey].import,
      history.summaries[dayKey].export
    );
  } catch (err) {
    console.warn("[history] Erreur écriture SQLite (daily_summaries) :", err.message);
  }

  console.log(`[History] 📝 Bilan définitif enregistré pour ${dayKey} : Yield=${history.summaries[dayKey].yield}kWh`);
}

module.exports = {
  get history() { return history; },
  loadHistoryFromDisk,
  recordHistoryPoint,
  recordDailySummary,
};
