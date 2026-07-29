"use strict";

const path    = require("path");
const fs      = require("fs");
const Database = require("better-sqlite3");
const { DB_FILE, HISTORY_FILE } = require("./config");

/* --------------------------------------------------------------------------
   Initialisation de la base de données
   -------------------------------------------------------------------------- */
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new Database(DB_FILE);

// Mode WAL : meilleures performances en lecture concurrente, résilience accrue
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

/* --------------------------------------------------------------------------
   Création des tables
   -------------------------------------------------------------------------- */
db.exec(`
  CREATE TABLE IF NOT EXISTS power_readings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    day_key    TEXT    NOT NULL,
    pv_power   REAL    NOT NULL DEFAULT 0,
    house_power REAL   NOT NULL DEFAULT 0,
    grid_power  REAL   NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_power_ts      ON power_readings(ts);
  CREATE INDEX IF NOT EXISTS idx_power_day_key ON power_readings(day_key);

  CREATE TABLE IF NOT EXISTS daily_summaries (
    day_key    TEXT PRIMARY KEY,
    yield_kwh  REAL NOT NULL DEFAULT 0,
    import_kwh REAL NOT NULL DEFAULT 0,
    export_kwh REAL NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );
`);

/* --------------------------------------------------------------------------
   Statements préparés (compilés une fois, réutilisés)
   -------------------------------------------------------------------------- */
const stmtInsertReading = db.prepare(`
  INSERT INTO power_readings (ts, day_key, pv_power, house_power, grid_power)
  VALUES (@ts, @dayKey, @pvPower, @housePower, @gridPower)
`);

const stmtUpsertSummary = db.prepare(`
  INSERT INTO daily_summaries (day_key, yield_kwh, import_kwh, export_kwh, updated_at)
  VALUES (@dayKey, @yieldKwh, @importKwh, @exportKwh, @updatedAt)
  ON CONFLICT(day_key) DO UPDATE SET
    yield_kwh  = excluded.yield_kwh,
    import_kwh = excluded.import_kwh,
    export_kwh = excluded.export_kwh,
    updated_at = excluded.updated_at
`);

const stmtGetReadingsByDay  = db.prepare(`SELECT * FROM power_readings WHERE day_key = ? ORDER BY ts ASC`);
const stmtGetSummaries      = db.prepare(`SELECT * FROM daily_summaries ORDER BY day_key DESC LIMIT ?`);
const stmtGetReadingsRange  = db.prepare(`SELECT * FROM power_readings WHERE ts BETWEEN ? AND ? ORDER BY ts ASC`);
const stmtCountReadings     = db.prepare(`SELECT COUNT(*) AS cnt FROM power_readings`);
const stmtGetSummariesRange = db.prepare(`SELECT * FROM daily_summaries WHERE day_key BETWEEN ? AND ? ORDER BY day_key ASC`);

/* --------------------------------------------------------------------------
   Migration one-shot depuis solax-history.json
   -------------------------------------------------------------------------- */
function migrateFromJson() {
  // Seulement si la DB est vide (premier démarrage)
  const { cnt } = stmtCountReadings.get();
  if (cnt > 0) {
    console.log(`[db] 📦 Base déjà peuplée (${cnt} points), migration ignorée.`);
    return;
  }

  let parsed = null;
  try {
    if (!fs.existsSync(HISTORY_FILE)) {
      console.log("[db] Aucun fichier JSON historique trouvé, migration ignorée.");
      return;
    }
    parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
  } catch (err) {
    console.warn("[db] Impossible de lire solax-history.json pour la migration :", err.message);
    return;
  }

  if (!parsed?.days || typeof parsed.days !== "object") {
    console.warn("[db] Format JSON historique invalide, migration ignorée.");
    return;
  }

  let totalReadings = 0;
  let totalSummaries = 0;

  const migrate = db.transaction(() => {
    // Migrer les points de puissance
    for (const [dayKey, points] of Object.entries(parsed.days)) {
      if (!Array.isArray(points)) continue;
      for (const point of points) {
        // Format: [ts, pvPower, housePower, gridPower]
        if (!Array.isArray(point) || point.length < 2) continue;
        stmtInsertReading.run({
          ts:         point[0],
          dayKey,
          pvPower:    point[1] ?? 0,
          housePower: point[2] ?? 0,
          gridPower:  point[3] ?? 0,
        });
        totalReadings++;
      }
    }

    // Migrer les bilans journaliers
    if (parsed.summaries && typeof parsed.summaries === "object") {
      for (const [dayKey, summary] of Object.entries(parsed.summaries)) {
        stmtUpsertSummary.run({
          dayKey,
          yieldKwh:  summary.yield  ?? 0,
          importKwh: summary.import ?? 0,
          exportKwh: summary.export ?? 0,
          updatedAt: summary.updatedAt ?? Date.now(),
        });
        totalSummaries++;
      }
    }
  });

  try {
    migrate();
    console.log(`[db] ✅ Migration réussie : ${totalReadings} points de puissance, ${totalSummaries} bilans journaliers importés.`);

    // Supprimer le fichier JSON source après succès
    fs.unlinkSync(HISTORY_FILE);
    console.log(`[db] 🗑️  solax-history.json supprimé après migration.`);
  } catch (err) {
    console.error("[db] ❌ Erreur durant la migration :", err.message);
  }
}

/**
 * Nettoyage automatique au démarrage des résumés journaliers corrompus (export >= yield).
 */
function repairCorruptSummaries() {
  try {
    const corrupt = db.prepare("SELECT * FROM daily_summaries WHERE yield_kwh > 0.1 AND export_kwh >= yield_kwh").all();
    if (!corrupt.length) return;

    let repaired = 0;
    const stmtUpdateExport = db.prepare("UPDATE daily_summaries SET export_kwh = ? WHERE day_key = ?");

    for (const s of corrupt) {
      const pts = stmtGetReadingsByDay.all(s.day_key);
      if (pts.length < 2) continue;
      let solarUsedKwh = 0;
      for (let i = 1; i < pts.length; i++) {
        const dt = (pts[i].ts - pts[i - 1].ts) / 3_600_000;
        if (dt <= 0 || dt > 0.5) continue;
        const pv = Math.max(0, (pts[i].pv_power + pts[i - 1].pv_power) / 2);
        const h  = Math.max(0, (pts[i].house_power + pts[i - 1].house_power) / 2);
        solarUsedKwh += Math.min(pv, h) * dt / 1000;
      }
      const cleanExport = Math.round(Math.max(0, s.yield_kwh - solarUsedKwh) * 10) / 10;
      stmtUpdateExport.run(cleanExport, s.day_key);
      repaired++;
    }
    if (repaired > 0) {
      console.log(`[db] 🛠️  ${repaired} bilan(s) journalier(s) corrompu(s) révisé(s) automatiquement en base.`);
    }
  } catch (err) {
    console.warn("[db] Avertissement lors du nettoyage des bilans :", err.message);
  }
}

/* --------------------------------------------------------------------------
   Lancer les migrations & nettoyages au chargement du module
   -------------------------------------------------------------------------- */
migrateFromJson();
repairCorruptSummaries();

/* --------------------------------------------------------------------------
   API publique
   -------------------------------------------------------------------------- */

/**
 * Insère un point de puissance (appelé à chaque cycle de polling).
 * @param {number} ts        Timestamp Unix ms
 * @param {string} dayKey    Date locale YYYY-MM-DD
 * @param {number} pvPower   Puissance PV totale (W)
 * @param {number} housePower Consommation maison (W)
 * @param {number} gridPower  Échange réseau (W, + = import, - = export)
 */
function insertPowerReading(ts, dayKey, pvPower, housePower, gridPower) {
  stmtInsertReading.run({ ts, dayKey, pvPower, housePower, gridPower });
}

/**
 * Insère ou met à jour le bilan d'un jour (appelé à minuit).
 * @param {string} dayKey
 * @param {number} yieldKwh
 * @param {number} importKwh
 * @param {number} exportKwh
 */
function upsertDailySummary(dayKey, yieldKwh, importKwh, exportKwh) {
  // Garde-fou à l'écriture : empêcher l'enregistrement d'un export supérieur à la production
  const cleanExport = (yieldKwh >= 0 && exportKwh > yieldKwh) ? yieldKwh : Math.max(0, exportKwh);
  stmtUpsertSummary.run({ dayKey, yieldKwh, importKwh, exportKwh: cleanExport, updatedAt: Date.now() });
}

/**
 * Retourne tous les points de puissance d'un jour donné.
 * @param {string} dayKey YYYY-MM-DD
 * @returns {Array}
 */
function getPowerReadings(dayKey) {
  return stmtGetReadingsByDay.all(dayKey);
}

/**
 * Retourne les N derniers bilans journaliers (plus récent en premier).
 * @param {number} limit
 * @returns {Array}
 */
function getDailySummaries(limit = 30) {
  return stmtGetSummaries.all(limit);
}

/**
 * Retourne les points de puissance entre deux timestamps Unix ms.
 * @param {number} startTs
 * @param {number} endTs
 * @returns {Array}
 */
function getPowerReadingsRange(startTs, endTs) {
  return stmtGetReadingsRange.all(startTs, endTs);
}

/** Fermeture propre de la base (à appeler au SIGINT/SIGTERM). */
function closeDb() {
  db.close();
  console.log("[db] 🔒 Base de données fermée proprement.");
}

/**
 * Calcule les statistiques agrégées par jour pour une plage de dates.
 * Retourne : { days: [{dayKey, yieldKwh, houseKwh, solarUsedKwh, importKwh, exportKwh, autoConso, independence}], totals, readings }
 * @param {string} fromDate  YYYY-MM-DD (inclusif)
 * @param {string} toDate    YYYY-MM-DD (inclusif)
 * @returns {object}
 */
function getStatsForRange(fromDate, toDate) {
  // Bornes timestamps (début de fromDate → fin de toDate, heure locale)
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  const startTs = new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime();
  const endTs   = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime();

  // Tous les points bruts (pour la simulation batterie côté client)
  const readings = stmtGetReadingsRange.all(startTs, endTs);

  // Résumés journaliers (pour import/export précis depuis les compteurs)
  const summaries = stmtGetSummariesRange.all(fromDate, toDate);
  const summaryMap = {};
  for (const s of summaries) summaryMap[s.day_key] = s;

  // Regrouper les points par day_key
  const byDay = {};
  for (const r of readings) {
    if (!byDay[r.day_key]) byDay[r.day_key] = [];
    byDay[r.day_key].push(r);
  }

  const days = [];

  for (const [dayKey, pts] of Object.entries(byDay)) {
    pts.sort((a, b) => a.ts - b.ts);

    let yieldKwh = 0, houseKwh = 0, solarUsedKwh = 0;

    for (let i = 1; i < pts.length; i++) {
      const dt = (pts[i].ts - pts[i - 1].ts) / 3_600_000; // heures
      if (dt <= 0 || dt > 0.5) continue; // Ignorer les gaps > 30 min
      const avgPv    = (pts[i].pv_power    + pts[i - 1].pv_power)    / 2;
      const avgHouse = (pts[i].house_power + pts[i - 1].house_power) / 2;
      yieldKwh     += Math.max(0, avgPv)    * dt / 1000;
      houseKwh     += Math.max(0, avgHouse) * dt / 1000;
      solarUsedKwh += Math.min(Math.max(0, avgPv), Math.max(0, avgHouse)) * dt / 1000;
    }

    // Préférer les données du résumé journalier si disponibles et valides (garde-fou contre les sauts de compteur)
    const summ = summaryMap[dayKey];
    const isSummaryCorrupt = summ && (summ.export_kwh > summ.yield_kwh || (summ.yield_kwh > 0.1 && summ.export_kwh >= summ.yield_kwh && solarUsedKwh > 0.1));

    let finalYield = yieldKwh;
    let finalSolarUsed = solarUsedKwh;
    let importKwh = 0;
    let exportKwh = 0;
    let finalHouse = houseKwh;

    if (summ && !isSummaryCorrupt) {
      finalYield     = summ.yield_kwh;
      importKwh      = summ.import_kwh;
      exportKwh      = summ.export_kwh;
      finalSolarUsed = Math.max(0, summ.yield_kwh - summ.export_kwh);
      finalHouse     = finalSolarUsed + summ.import_kwh;
    } else {
      // Garde-fou : Recours aux intégrales trapezoïdales réelles si le résumé est corrompu ou absent
      finalYield     = summ ? summ.yield_kwh : yieldKwh;
      importKwh      = summ ? summ.import_kwh : Math.max(0, houseKwh - solarUsedKwh);
      finalSolarUsed = Math.min(solarUsedKwh, finalYield);
      exportKwh      = Math.max(0, finalYield - finalSolarUsed);
      finalHouse     = finalSolarUsed + importKwh;
    }

    const autoConso    = finalYield > 0 ? Math.min(1.0, Math.max(0, finalSolarUsed / finalYield))  : null;
    const independence = finalHouse > 0 ? Math.min(1.0, Math.max(0, finalSolarUsed / finalHouse))  : null;

    days.push({
      dayKey,
      yieldKwh:     Math.round(finalYield     * 1000) / 1000,
      houseKwh:     Math.round(finalHouse     * 1000) / 1000,
      solarUsedKwh: Math.round(finalSolarUsed * 1000) / 1000,
      importKwh:    Math.round(importKwh       * 1000) / 1000,
      exportKwh:    Math.round(exportKwh       * 1000) / 1000,
      autoConso,
      independence,
    });
  }

  days.sort((a, b) => a.dayKey.localeCompare(b.dayKey));

  // Totaux et agrégats
  const validAC  = days.filter(d => d.autoConso    !== null).map(d => d.autoConso);
  const validInd = days.filter(d => d.independence !== null).map(d => d.independence);

  const totals = {
    yieldKwh:     Math.round(days.reduce((s, d) => s + d.yieldKwh, 0) * 100)     / 100,
    houseKwh:     Math.round(days.reduce((s, d) => s + d.houseKwh, 0) * 100)     / 100,
    solarUsedKwh: Math.round(days.reduce((s, d) => s + d.solarUsedKwh, 0) * 100) / 100,
    importKwh:    Math.round(days.reduce((s, d) => s + d.importKwh, 0) * 100)     / 100,
    exportKwh:    Math.round(days.reduce((s, d) => s + d.exportKwh, 0) * 100)     / 100,
    autoConso: {
      avg: validAC.length  ? Math.round(validAC.reduce((a, b)  => a + b, 0) / validAC.length  * 1000) / 10 : null,
      min: validAC.length  ? Math.round(Math.min(...validAC)  * 1000) / 10 : null,
      max: validAC.length  ? Math.round(Math.max(...validAC)  * 1000) / 10 : null,
    },
    independence: {
      avg: validInd.length ? Math.round(validInd.reduce((a, b) => a + b, 0) / validInd.length * 1000) / 10 : null,
      min: validInd.length ? Math.round(Math.min(...validInd) * 1000) / 10 : null,
      max: validInd.length ? Math.round(Math.max(...validInd) * 1000) / 10 : null,
    },
    dayCount: days.length,
    readingCount: readings.length,
  };

  return { days, totals }; // Ne pas retourner les readings bruts (trop volumineux)
}



/**
 * Simule plusieurs capacités de batterie sur une plage de dates (approche 100% physique).
 * @param {string} fromDate   YYYY-MM-DD
 * @param {string} toDate     YYYY-MM-DD
 * @param {number} voltage    Tension (V)
 * @param {number} dod        Profondeur de décharge (0-1)
 * @param {number} efficiency Rendement aller-retour (0-1)
 * @param {number} priceImport Prix kWh acheté (€)
 * @param {number} priceSurplus Prix surplus revendu (€)
 * @returns {object}
 */
function simulateBattery(fromDate, toDate, voltage, dod, efficiency, priceImport = 0.20, priceSurplus = 0.04) {
  const [fy, fm, fd] = fromDate.split("-").map(Number);
  const [ty, tm, td] = toDate.split("-").map(Number);
  const startTs = new Date(fy, fm - 1, fd, 0, 0, 0, 0).getTime();
  const endTs   = new Date(ty, tm - 1, td, 23, 59, 59, 999).getTime();

  const pts = stmtGetReadingsRange.all(startTs, endTs);

  if (pts.length < 2) return { error: "Données insuffisantes pour la simulation." };

  // Baseline
  let baseYield = 0, baseHouse = 0, baseSolarUsed = 0;
  for (let i = 1; i < pts.length; i++) {
    const dt = (pts[i].ts - pts[i - 1].ts) / 3_600_000;
    if (dt <= 0 || dt > 0.5) continue;
    const pv    = Math.max(0, (pts[i].pv_power    + pts[i - 1].pv_power)    / 2);
    const house = Math.max(0, (pts[i].house_power + pts[i - 1].house_power) / 2);
    baseYield     += pv    * dt / 1000;
    baseHouse     += house * dt / 1000;
    baseSolarUsed += Math.min(pv, house) * dt / 1000;
  }

  if (baseHouse < 0.1) return { error: "Données de consommation maison insuffisantes." };

  const totalDays = Math.max(1, (endTs - startTs) / 86_400_000);
  const baseInd       = baseSolarUsed / baseHouse;
  const baseAC        = baseYield > 0 ? baseSolarUsed / baseYield : 0;
  const baseImportKwh = Math.max(0, baseHouse - baseSolarUsed);
  const baseExportKwh = Math.max(0, baseYield - baseSolarUsed);
  const sqrtEff       = Math.sqrt(efficiency);

  // Simulation pour une capacité donnée avec Warm-up sur TOUTE la période (2 passes)
  function simCap(capKwh) {
    const usable = capKwh * dod;
    let soc = usable * 0.5; // Démarrage à 50% de la capacité utile

    // Passe 1 : Warm-up sur TOUTE la période pour stabiliser le SOC final
    for (let i = 1; i < pts.length; i++) {
      const dt = (pts[i].ts - pts[i - 1].ts) / 3_600_000;
      if (dt <= 0 || dt > 0.5) continue;
      const pv    = Math.max(0, (pts[i].pv_power    + pts[i - 1].pv_power)    / 2);
      const house = Math.max(0, (pts[i].house_power + pts[i - 1].house_power) / 2);
      const surplus = (pv - house) * dt / 1000;
      if (surplus > 0) {
        soc = Math.min(soc + surplus * sqrtEff, usable);
      } else {
        const dis = Math.min(-surplus, soc * sqrtEff);
        soc -= dis / sqrtEff;
        soc = Math.max(0, soc);
      }
    }

    // Passe 2 : Simulation réelle sur TOUTE la période avec suivi quotidien du SOC
    let extra = 0;
    const dailyMaxSocMap = {};

    for (let i = 1; i < pts.length; i++) {
      const dt = (pts[i].ts - pts[i - 1].ts) / 3_600_000;
      if (dt <= 0 || dt > 0.5) continue;
      const pv    = Math.max(0, (pts[i].pv_power    + pts[i - 1].pv_power)    / 2);
      const house = Math.max(0, (pts[i].house_power + pts[i - 1].house_power) / 2);
      const surplus = (pv - house) * dt / 1000;
      const dayKey = pts[i].day_key;

      if (surplus > 0) {
        soc = Math.min(soc + surplus * sqrtEff, usable);
        if (!dailyMaxSocMap[dayKey] || soc > dailyMaxSocMap[dayKey]) {
          dailyMaxSocMap[dayKey] = soc;
        }
      } else {
        const dis = Math.min(-surplus, soc * sqrtEff);
        soc -= dis / sqrtEff;
        soc = Math.max(0, soc);
        extra += dis;
      }
    }

    const newSolarUsed = baseSolarUsed + extra;
    const newImportKwh = Math.max(0, baseHouse - newSolarUsed);
    const newExportKwh = Math.max(0, baseYield - newSolarUsed);

    const newInd = Math.min(1, newSolarUsed / baseHouse);
    const newAC  = baseYield > 0 ? Math.min(1, newSolarUsed / baseYield) : 0;

    const surplusCapturedPct = baseExportKwh > 0 ? Math.min(100, Math.round((extra / baseExportKwh) * 1000) / 10) : 100;

    // Métriques d'utilisation quotidienne
    const dailyCycles = Math.round((extra / (usable * totalDays)) * 100) / 100;
    const dailySocVals = Object.values(dailyMaxSocMap);
    const avgDailyMaxSocPct = dailySocVals.length
      ? Math.min(100, Math.round((dailySocVals.reduce((a, b) => a + b, 0) / (dailySocVals.length * usable)) * 100))
      : 0;

    // Taux d'utilisation physique de la capacité (%) = remplissage moyen quotidien
    const capacityUtilizationPct = avgDailyMaxSocPct;

    // Économie brute estimée sur la période selon les tarifs spécifiés
    const netGainPerKwh = Math.max(0, priceImport - priceSurplus);
    const estimatedSavingsEur = Math.round(extra * netGainPerKwh * 10) / 10;

    return {
      acPct:                  Math.round(newAC  * 1000) / 10,
      acGainPct:              Math.round((newAC - baseAC) * 1000) / 10,
      indPct:                 Math.round(newInd * 1000) / 10,
      indGainPct:             Math.round((newInd - baseInd) * 1000) / 10,
      exportRemKwh:           Math.round(newExportKwh * 10) / 10,
      importRemKwh:           Math.round(newImportKwh * 10) / 10,
      cycledKwh:              Math.round(extra * 10) / 10,
      estimatedSavingsEur,
      dailyCycles,
      avgDailyMaxSocPct,
      surplusCapturedPct,
      capacityUtilizationPct,
      extraKwh:               extra,
    };
  }

  // Courbe dynamique 0.5 → 100 kWh
  const capacitiesKwh = [];
  let prevAcForCeiling = 0;

  for (let c = 0.5; c <= 100.01; ) {
    const roundC = Math.round(c * 10) / 10;
    capacitiesKwh.push(roundC);

    const res = simCap(roundC);
    if (res.acPct >= 99.9) {
      break;
    }

    if (roundC >= 20 && (roundC % 5 === 0)) {
      if (prevAcForCeiling > 0 && (res.acPct - prevAcForCeiling) < 0.1) {
        break;
      }
      prevAcForCeiling = res.acPct;
    }

    if (c < 20) c += 0.5;
    else if (c < 50) c += 1.0;
    else c += 2.0;
  }

  const curve = capacitiesKwh.map(c => ({ capKwh: c, ...simCap(c) }));

  // 1) Batterie Recommandée (physique) : plus petite batterie réalisant un taux de remplissage efficace (~82% du surplus max absorbable)
  const maxExtra = curve[curve.length - 1].extraKwh;
  const recObj = curve.find(c => c.extraKwh >= maxExtra * 0.82) || curve[curve.length - 1];

  // 2) Limite Utile (physique) : point d'inflexion où le gain marginal quotidien chute sous 0.15 kWh/jour par kWh ajouté
  let usefulLimitIdx = curve.length - 1;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].capKwh <= recObj.capKwh) continue;
    const step = curve[i].capKwh - curve[i - 1].capKwh;
    const gainPerDay = ((curve[i].extraKwh - curve[i - 1].extraKwh) / step) / totalDays;
    if (gainPerDay < 0.15) {
      usefulLimitIdx = i;
      break;
    }
  }
  const usefulLimitObj = curve[usefulLimitIdx];

  // Scénarios pour le tableau comparatif
  const defaultSteps = [0, 2, 5, 10, 15, 20, 30, 40, 50, 75, 100];
  const maxCapSimulated = curve[curve.length - 1].capKwh;

  const capSet = new Set(defaultSteps.filter(s => s <= maxCapSimulated));
  capSet.add(recObj.capKwh);
  if (usefulLimitObj.capKwh !== recObj.capKwh) capSet.add(usefulLimitObj.capKwh);

  const sortedCaps = Array.from(capSet).sort((a, b) => a - b);

  const scenarios = sortedCaps.map(cap => {
    if (cap === 0) return {
      capKwh: 0, capAh: 0,
      acPct: Math.round(baseAC * 1000) / 10,
      indPct: Math.round(baseInd * 1000) / 10,
      exportRemKwh: Math.round(baseExportKwh * 10) / 10,
      importRemKwh: Math.round(baseImportKwh * 10) / 10,
      cycledKwh: 0,
      estimatedSavingsEur: 0,
      dailyCycles: 0,
      avgDailyMaxSocPct: 0,
      surplusCapturedPct: 0,
      capacityUtilizationPct: 0,
      isBaseline: true,
      isRecommended: false,
      isUsefulLimit: false,
    };
    const r = simCap(cap);
    return {
      capKwh: cap,
      capAh: Math.round((cap * 1000) / (voltage * dod)),
      ...r,
      isBaseline: false,
      isRecommended: cap === recObj.capKwh,
      isUsefulLimit: cap === usefulLimitObj.capKwh && cap !== recObj.capKwh,
    };
  });

  return {
    baseline: {
      acPct:        Math.round(baseAC  * 1000) / 10,
      indPct:       Math.round(baseInd * 1000) / 10,
      exportKwh:    Math.round(baseExportKwh * 10) / 10,
      importKwh:    Math.round(baseImportKwh * 10) / 10,
    },
    capacitiesKwh,
    results: curve,
    recommended: {
      capKwh:                 recObj.capKwh,
      capAh:                  Math.round((recObj.capKwh * 1000) / (voltage * dod)),
      surplusCapturedPct:     recObj.surplusCapturedPct,
      acPct:                  recObj.acPct,
      indPct:                 recObj.indPct,
      exportRemKwh:           recObj.exportRemKwh,
      importRemKwh:           recObj.importRemKwh,
      capacityUtilizationPct: recObj.capacityUtilizationPct,
      dailyCycles:            recObj.dailyCycles,
      cycledKwh:              recObj.cycledKwh,
      estimatedSavingsEur:    recObj.estimatedSavingsEur,
    },
    usefulLimit: {
      capKwh:                 usefulLimitObj.capKwh,
      capAh:                  Math.round((usefulLimitObj.capKwh * 1000) / (voltage * dod)),
      capacityUtilizationPct: usefulLimitObj.capacityUtilizationPct,
      dailyCycles:            usefulLimitObj.dailyCycles,
    },
    scenarios,
  };
}

module.exports = {
  insertPowerReading,
  upsertDailySummary,
  getPowerReadings,
  getDailySummaries,
  getPowerReadingsRange,
  getStatsForRange,
  simulateBattery,
  closeDb,
};
