"use strict";

const { HISTORY_FILE, HISTORY_RETENTION_DAYS, wifiSns } = require("./config");
const { atomicWrite, safeReadJson } = require("./storage");

/* --------------------------------------------------------------------------
   État en RAM
   -------------------------------------------------------------------------- */
let history = { version: 2, days: {} };
let historySaveTimer = null;

/* --------------------------------------------------------------------------
   Persistance disque
   -------------------------------------------------------------------------- */
function loadHistoryFromDisk() {
  const parsed = safeReadJson(HISTORY_FILE);
  if (!parsed) return;
  if (typeof parsed.version !== "number" || !parsed.days || typeof parsed.days !== "object") {
    console.warn("[history] Fichier historique invalide ou incompatible — réinitialisation.");
    return;
  }
  history = parsed;
}

/** Sauvegarde asynchrone non-bloquante avec debounce (500 ms). */
function scheduleHistorySave() {
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = setTimeout(async () => {
    try {
      await atomicWrite(HISTORY_FILE, JSON.stringify(history));
    } catch { }
  }, 500);
}

/* --------------------------------------------------------------------------
   Clé de jour locale
   -------------------------------------------------------------------------- */
function getLocalDayKey() {
  // Utilise Intl.DateTimeFormat pour forcer le fuseau horaire Europe/Paris (France)
  // en-CA formatte les dates en YYYY-MM-DD nativement.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/* --------------------------------------------------------------------------
   Nettoyage des jours trop anciens
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

  const todayKey = getLocalDayKey();
  if (!history.days[todayKey]) history.days[todayKey] = [];
  history.days[todayKey].push([
    now,
    Math.round(totalPower * 100) / 100,
    Math.round(housePower * 100) / 100,
    Math.round(gridPower  * 100) / 100,
  ]);

  console.log(`[${new Date().toLocaleTimeString()}] 📈 Nouveau point historique : PV=${Math.round(totalPower)}W | Maison=${Math.round(housePower)}W`);
  pruneHistoryDays();
  scheduleHistorySave();
}

module.exports = {
  get history() { return history; },
  loadHistoryFromDisk,
  scheduleHistorySave,
  recordHistoryPoint,
};
