#!/usr/bin/env node
"use strict";

/**
 * import-history.js — Outil d'import de fichiers solax-history.json vers SQLite
 *
 * Usage :
 *   node tools/import-history.js <fichier.json> [fichier2.json] ...
 *   node tools/import-history.js <dossier/>          # scanne tous les .json du dossier
 *
 * Options :
 *   --delete    Supprime les fichiers JSON source après un import réussi
 *   --dry-run   Simule l'import sans rien écrire en DB
 *   --help      Affiche cette aide
 *
 * Exemples :
 *   node tools/import-history.js data/old-history.json
 *   node tools/import-history.js backups/ --delete
 *   node tools/import-history.js backups/ --dry-run
 */

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const fs      = require("fs");
const path    = require("path");
const Database = require("better-sqlite3");
const { DB_FILE } = require("../lib/config");

/* --------------------------------------------------------------------------
   Parsing des arguments
   -------------------------------------------------------------------------- */
const args    = process.argv.slice(2);
const doDelete  = args.includes("--delete");
const dryRun    = args.includes("--dry-run");
const showHelp  = args.includes("--help") || args.length === 0;
const inputs    = args.filter(a => !a.startsWith("--"));

if (showHelp) {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         SolaX Dashboard — Import JSON → SQLite               ║
╚══════════════════════════════════════════════════════════════╝

Usage :
  node tools/import-history.js <fichier.json> [fichier2.json] ...
  node tools/import-history.js <dossier/>

Options :
  --delete    Supprime les fichiers source après import réussi
  --dry-run   Simule l'import sans rien écrire en DB
  --help      Affiche cette aide

Exemples :
  node tools/import-history.js data/old-history.json
  node tools/import-history.js backups/ --delete
  node tools/import-history.js backups/ --dry-run
  `);
  process.exit(0);
}

/* --------------------------------------------------------------------------
   Résolution des fichiers à traiter
   -------------------------------------------------------------------------- */
function resolveFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    if (!fs.existsSync(abs)) {
      console.warn(`⚠️  Introuvable : ${abs}`);
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      const jsonFiles = fs.readdirSync(abs)
        .filter(f => f.endsWith(".json"))
        .map(f => path.join(abs, f));
      files.push(...jsonFiles);
    } else {
      files.push(abs);
    }
  }
  return files;
}

/* --------------------------------------------------------------------------
   Validation du format JSON
   -------------------------------------------------------------------------- */
function parseHistoryFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { error: `Impossible de lire le fichier : ${err.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `JSON invalide : ${err.message}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Le fichier ne contient pas un objet JSON valide." };
  }
  if (!parsed.days || typeof parsed.days !== "object") {
    return { error: "Champ 'days' manquant ou invalide." };
  }

  return { data: parsed };
}

/* --------------------------------------------------------------------------
   Ouverture de la DB
   -------------------------------------------------------------------------- */
let db = null;
let stmtInsert    = null;
let stmtUpsert    = null;
let stmtGetByDay  = null;

if (!dryRun) {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`❌ Base de données introuvable : ${DB_FILE}`);
    console.error("   Lancez le serveur au moins une fois pour l'initialiser.");
    process.exit(1);
  }

  db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");

  stmtInsert = db.prepare(`
    INSERT OR IGNORE INTO power_readings (ts, day_key, pv_power, house_power, grid_power)
    VALUES (@ts, @dayKey, @pvPower, @housePower, @gridPower)
  `);

  stmtUpsert = db.prepare(`
    INSERT INTO daily_summaries (day_key, yield_kwh, import_kwh, export_kwh, updated_at)
    VALUES (@dayKey, @yieldKwh, @importKwh, @exportKwh, @updatedAt)
    ON CONFLICT(day_key) DO UPDATE SET
      yield_kwh  = excluded.yield_kwh,
      import_kwh = excluded.import_kwh,
      export_kwh = excluded.export_kwh,
      updated_at = excluded.updated_at
  `);

  // Créer un index unique sur ts pour que INSERT OR IGNORE fonctionne
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_power_ts_unique ON power_readings(ts)`);

  stmtGetByDay = db.prepare(`SELECT COUNT(*) AS cnt FROM power_readings WHERE day_key = ?`);
}

/* --------------------------------------------------------------------------
   Import d'un fichier
   -------------------------------------------------------------------------- */
function importFile(filePath) {
  console.log(`\n📂 Traitement : ${path.basename(filePath)}`);

  const { data, error } = parseHistoryFile(filePath);
  if (error) {
    console.error(`   ❌ ${error}`);
    return { success: false };
  }

  let totalReadings  = 0;
  let totalSkipped   = 0;
  let totalSummaries = 0;
  const daysSeen     = [];

  if (!dryRun) {
    const doImport = db.transaction(() => {
      // --- Points de puissance ---
      for (const [dayKey, points] of Object.entries(data.days)) {
        if (!Array.isArray(points)) continue;
        daysSeen.push(dayKey);

        for (const point of points) {
          if (!Array.isArray(point) || point.length < 2) continue;

          const [ts, pvPower, housePower = 0, gridPower = 0] = point;
          if (typeof ts !== "number" || isNaN(ts)) continue;

          const result = stmtInsert.run({
            ts,
            dayKey,
            pvPower:    Math.round((pvPower    || 0) * 100) / 100,
            housePower: Math.round((housePower || 0) * 100) / 100,
            gridPower:  Math.round((gridPower  || 0) * 100) / 100,
          });

          if (result.changes > 0) {
            totalReadings++;
          } else {
            totalSkipped++; // Doublon ignoré (même timestamp)
          }
        }
      }

      // --- Bilans journaliers ---
      if (data.summaries && typeof data.summaries === "object") {
        for (const [dayKey, summary] of Object.entries(data.summaries)) {
          stmtUpsert.run({
            dayKey,
            yieldKwh:  Math.round((summary.yield  || 0) * 100) / 100,
            importKwh: Math.round((summary.import || 0) * 100) / 100,
            exportKwh: Math.round((summary.export || 0) * 100) / 100,
            updatedAt: summary.updatedAt || Date.now(),
          });
          totalSummaries++;
        }
      }
    });

    doImport();
  } else {
    // Dry-run : compter seulement
    for (const [dayKey, points] of Object.entries(data.days)) {
      if (!Array.isArray(points)) continue;
      daysSeen.push(dayKey);
      totalReadings += points.filter(p => Array.isArray(p) && p.length >= 2).length;
    }
    totalSummaries = data.summaries ? Object.keys(data.summaries).length : 0;
  }

  // Rapport
  console.log(`   📅 Jours trouvés   : ${daysSeen.sort().join(", ") || "(aucun)"}`);
  console.log(`   📈 Points importés : ${totalReadings}${dryRun ? " (simulation)" : ""}`);
  if (totalSkipped > 0) {
    console.log(`   ⏭️  Doublons ignorés : ${totalSkipped}`);
  }
  if (totalSummaries > 0) {
    console.log(`   📊 Bilans importés : ${totalSummaries}${dryRun ? " (simulation)" : ""}`);
  }

  // Suppression du fichier source si demandé
  if (doDelete && !dryRun && totalReadings + totalSummaries > 0) {
    try {
      fs.unlinkSync(filePath);
      console.log(`   🗑️  Fichier supprimé : ${path.basename(filePath)}`);
    } catch (err) {
      console.warn(`   ⚠️  Impossible de supprimer le fichier : ${err.message}`);
    }
  }

  return { success: true, totalReadings, totalSkipped, totalSummaries };
}

/* --------------------------------------------------------------------------
   Point d'entrée principal
   -------------------------------------------------------------------------- */
const files = resolveFiles(inputs);

if (files.length === 0) {
  console.error("❌ Aucun fichier JSON trouvé dans les chemins spécifiés.");
  process.exit(1);
}

console.log(`\n🗄️  SolaX Dashboard — Import JSON → SQLite`);
console.log(`   Base de données : ${DB_FILE}`);
if (dryRun)   console.log("   ⚠️  MODE SIMULATION (--dry-run) : aucune écriture en DB");
if (doDelete) console.log("   🗑️  Suppression des sources activée (--delete)");
console.log(`   ${files.length} fichier(s) à traiter\n`);

let grandTotal    = { readings: 0, skipped: 0, summaries: 0, success: 0, failed: 0 };

for (const file of files) {
  const result = importFile(file);
  if (result.success) {
    grandTotal.readings   += result.totalReadings;
    grandTotal.skipped    += result.totalSkipped;
    grandTotal.summaries  += result.totalSummaries;
    grandTotal.success++;
  } else {
    grandTotal.failed++;
  }
}

// Résumé final
console.log(`\n${"─".repeat(55)}`);
console.log(`✅ Import terminé`);
console.log(`   Fichiers traités : ${grandTotal.success} / ${files.length}`);
console.log(`   Points importés  : ${grandTotal.readings}`);
if (grandTotal.skipped > 0) {
  console.log(`   Doublons ignorés : ${grandTotal.skipped}`);
}
if (grandTotal.summaries > 0) {
  console.log(`   Bilans importés  : ${grandTotal.summaries}`);
}
if (grandTotal.failed > 0) {
  console.log(`   ⚠️  Fichiers en erreur : ${grandTotal.failed}`);
}

if (db) db.close();
