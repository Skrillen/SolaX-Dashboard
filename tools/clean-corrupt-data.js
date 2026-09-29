#!/usr/bin/env node
"use strict";

/**
 * clean-corrupt-data.js
 *
 * Outil de nettoyage et de gestion des jours corrompus suite à l'incident du 23-29/09.
 *
 * Options :
 *   --delete-days       Supprime les journées 2026-09-24 à 2026-09-28 de la base (readings + summaries)
 *   --fix-today         Recalibre solax-cache.json pour AUJOURD'HUI (supprime le faux pic de 94 kWh)
 *   --set-summary <day> <yield> <import> <export>  Insère les valeurs officielles de l'app SolaX
 *   --status            Affiche l'état actuel de la base pour la semaine
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "solax.db");
const CACHE_PATH = path.join(__dirname, "..", "data", "solax-cache.json");

const db = new Database(DB_PATH);
const args = process.argv.slice(2);

const TARGET_DAYS = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'];

console.log("==================================================================");
console.log("             SolaX Dashboard — Gestion des données                ");
console.log("==================================================================");

// Option 1 : Insérer des valeurs manuelles exactes depuis l'app
const setSummaryIdx = args.indexOf("--set-summary");
if (setSummaryIdx !== -1) {
  const day = args[setSummaryIdx + 1];
  const y   = parseFloat(args[setSummaryIdx + 2]);
  const imp = parseFloat(args[setSummaryIdx + 3]);
  const exp = parseFloat(args[setSummaryIdx + 4]);

  if (!day || isNaN(y) || isNaN(imp) || isNaN(exp)) {
    console.error("❌ Format invalide : node tools/clean-corrupt-data.js --set-summary YYYY-MM-DD <yield_kwh> <import_kwh> <export_kwh>");
    process.exit(1);
  }

  db.prepare(`
    INSERT INTO daily_summaries (day_key, yield_kwh, import_kwh, export_kwh, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(day_key) DO UPDATE SET
      yield_kwh = excluded.yield_kwh,
      import_kwh = excluded.import_kwh,
      export_kwh = excluded.export_kwh,
      updated_at = excluded.updated_at
  `).run(day, y, imp, exp, Date.now());

  console.log(`✅ Bilan enregistré avec succès pour ${day} : Yield=${y} kWh | Import=${imp} kWh | Export=${exp} kWh`);
  process.exit(0);
}

// Option 2 : Supprimer les jours buggés
if (args.includes("--delete-days")) {
  console.log("\n🗑️  Suppression des données des jours buggés (24/09 au 28/09)...");
  
  const placeholders = TARGET_DAYS.map(() => '?').join(',');
  const delReadings = db.prepare(`DELETE FROM power_readings WHERE day_key IN (${placeholders})`);
  const delSummaries = db.prepare(`DELETE FROM daily_summaries WHERE day_key IN (${placeholders})`);

  const tx = db.transaction(() => {
    const rRes = delReadings.run(...TARGET_DAYS);
    const sRes = delSummaries.run(...TARGET_DAYS);
    console.log(`  - Points power_readings supprimés : ${rRes.changes}`);
    console.log(`  - Bilans daily_summaries supprimés : ${sRes.changes}`);
  });

  tx();
  console.log("✅ Jours corrompus supprimés proprement de la base de données !");
}

// Option 3 : Corriger le baseline d'aujourd'hui dans le cache
if (args.includes("--fix-today")) {
  console.log("\n🔧 Recalibration du baseline d'aujourd'hui dans solax-cache.json...");
  if (fs.existsSync(CACHE_PATH)) {
    try {
      const cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
      if (cache.meter && cache.meter.data) {
        const m = cache.meter.data;

        // Calcul énergie mesurée aujourd'hui depuis 04h12
        const todayPts = db.prepare(`SELECT ts, grid_power FROM power_readings WHERE day_key = '2026-09-29' ORDER BY ts ASC`).all();
        let expToday = 0, impToday = 0;
        for (let i = 1; i < todayPts.length; i++) {
          const dt = (todayPts[i].ts - todayPts[i-1].ts) / 3600000;
          if (dt <= 0 || dt > 0.5) continue;
          const avgG = (todayPts[i].grid_power + todayPts[i-1].grid_power) / 2;
          if (avgG > 0) expToday += avgG * dt / 1000;
          else if (avgG < 0) impToday += Math.abs(avgG) * dt / 1000;
        }

        // Talon nuit estimé ~1.8 kWh
        const realImpToday = Math.round((impToday + 1.8) * 10) / 10;
        const realExpToday = Math.round(expToday * 10) / 10;

        m.importEnergyDayBase = Math.round((m.importEnergy - realImpToday) * 10) / 10;
        m.exportEnergyDayBase = Math.round((m.exportEnergy - realExpToday) * 10) / 10;
        m.dailyImport = realImpToday;
        m.dailyExport = realExpToday;

        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
        console.log(`✅ Baseline corrigé :`);
        console.log(`   dailyImport  : ${realImpToday} kWh (au lieu de 94 kWh !)`);
        console.log(`   dailyExport  : ${realExpToday} kWh (au lieu de 78 kWh !)`);
        console.log(`   importEnergyDayBase : ${m.importEnergyDayBase} kWh`);
      }
    } catch (e) {
      console.error("Erreur mise à jour cache:", e.message);
    }
  }
}

// État actuel
console.log("\n📊 État actuel des bilans journaliers récents (daily_summaries) :");
const summaries = db.prepare(`SELECT day_key, yield_kwh, import_kwh, export_kwh FROM daily_summaries WHERE day_key >= '2026-09-20' ORDER BY day_key ASC`).all();
console.table(summaries);

console.log("\nCommandes disponibles :");
console.log("  1) Supprimer les jours buggés : node tools/clean-corrupt-data.js --delete-days");
console.log("  2) Réparer AUJOURD'HUI dans le cache : node tools/clean-corrupt-data.js --fix-today");
console.log("  3) Saisir les vraies valeurs d'un jour : node tools/clean-corrupt-data.js --set-summary <YYYY-MM-DD> <yield> <import> <export>");
console.log("==================================================================");
