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
  stmtUpsertSummary.run({ dayKey, yieldKwh, importKwh, exportKwh, updatedAt: Date.now() });
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

/* --------------------------------------------------------------------------
   Lancer la migration au chargement du module
   -------------------------------------------------------------------------- */
migrateFromJson();

module.exports = {
  insertPowerReading,
  upsertDailySummary,
  getPowerReadings,
  getDailySummaries,
  getPowerReadingsRange,
  closeDb,
};
