#!/usr/bin/env node
"use strict";

/**
 * fix-meter-blackout.js
 *
 * Outil d'analyse et de réparation de l'incident compteur du 23/09 au 29/09/2026.
 *
 * Usage :
 *   node tools/fix-meter-blackout.js --analyze
 *   node tools/fix-meter-blackout.js --fix-today     # Répare le baseline d'aujourd'hui dans solax-cache.json
 *   node tools/fix-meter-blackout.js --fix-summaries # Répartit le delta d'import/export réel sur les jours 24-28/09
 *   node tools/fix-meter-blackout.js --apply-all     # Applique les réparations
 */

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = path.join(__dirname, "..", "data", "solax.db");
const CACHE_PATH = path.join(__dirname, "..", "data", "solax-cache.json");

const db = new Database(DB_PATH);

const args = process.argv.slice(2);
const doAnalyze = args.includes("--analyze") || args.length === 0;
const doFixToday = args.includes("--fix-today") || args.includes("--apply-all");
const doFixSummaries = args.includes("--fix-summaries") || args.includes("--apply-all");

console.log("==================================================================");
console.log("   SolaX Dashboard — Diagnostic & Réparation Incident Compteur   ");
console.log("==================================================================");

// 1. Analyse des points de coupure
const blackoutStart = db.prepare(`
  SELECT ts, datetime(ts/1000, 'unixepoch', 'localtime') as dt, pv_power, house_power, grid_power
  FROM power_readings
  WHERE day_key = '2026-09-23' AND grid_power != 0
  ORDER BY ts DESC LIMIT 1
`).get();

const blackoutEnd = db.prepare(`
  SELECT ts, datetime(ts/1000, 'unixepoch', 'localtime') as dt, pv_power, house_power, grid_power
  FROM power_readings
  WHERE day_key = '2026-09-29' AND grid_power != 0
  ORDER BY ts ASC LIMIT 1
`).get();

console.log("\n📡 Période d'interruption du compteur :");
console.log(`  - Début incident : ${blackoutStart ? blackoutStart.dt : "Inconnu"} (dernier point grid_power != 0)`);
console.log(`  - Fin incident   : ${blackoutEnd ? blackoutEnd.dt : "Inconnu"} (premier point grid_power != 0)`);

// 2. Analyse du cache
let cache = null;
if (fs.existsSync(CACHE_PATH)) {
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch (e) {
    console.error("Erreur lecture cache:", e.message);
  }
}

if (cache && cache.meter) {
  const m = cache.meter.data;
  console.log("\n📦 État actuel du cache compteur (solax-cache.json) :");
  console.log(`  - Index Import actuel      : ${m.importEnergy} kWh`);
  console.log(`  - Baseline Import (bloqué) : ${m.importEnergyDayBase} kWh`);
  console.log(`  - dailyImport calculé      : ${m.dailyImport.toFixed(2)} kWh  <-- ⚠️ CUMUL DES 6 JOURS !`);
  console.log(`  - Index Export actuel      : ${m.exportEnergy} kWh`);
  console.log(`  - Baseline Export (bloqué) : ${m.exportEnergyDayBase} kWh`);
  console.log(`  - dailyExport calculé      : ${m.dailyExport.toFixed(2)} kWh  <-- ⚠️ CUMUL DES 6 JOURS !`);
}

// 3. Calcul de l'énergie réelle aujourd'hui (depuis minuit le 29/09)
const todayPts = db.prepare(`
  SELECT ts, pv_power, grid_power
  FROM power_readings
  WHERE day_key = '2026-09-29'
  ORDER BY ts ASC
`).all();

let todayMeasuredImport = 0;
let todayMeasuredExport = 0;
for (let i = 1; i < todayPts.length; i++) {
  const dt = (todayPts[i].ts - todayPts[i-1].ts) / 3600000;
  if (dt <= 0 || dt > 0.5) continue;
  const avgG = (todayPts[i].grid_power + todayPts[i-1].grid_power) / 2;
  if (avgG > 0) todayMeasuredExport += avgG * dt / 1000;
  else if (avgG < 0) todayMeasuredImport += Math.abs(avgG) * dt / 1000;
}

// Estimation de l'import de nuit entre 00:00 et 04:12 (environ 4.2h à ~450W talon moyen = ~1.9 kWh)
const nightImportEst = 1.9;
const todayRealImport = Math.round((todayMeasuredImport + nightImportEst) * 10) / 10;
const todayRealExport = Math.round(todayMeasuredExport * 10) / 10;

console.log("\n⚡ Estimation réelle pour aujourd'hui (29/09) :");
console.log(`  - Import mesuré depuis 04h12       : ${todayMeasuredImport.toFixed(2)} kWh`);
console.log(`  - Import nuit estimé (00h-04h12)   : ~${nightImportEst} kWh`);
console.log(`  - VRAI Import aujourd'hui estimé   : ~${todayRealImport} kWh (au lieu de 93.3 kWh !)`);
console.log(`  - VRAI Export aujourd'hui mesuré   : ~${todayRealExport} kWh (au lieu de 78.1 kWh !)`);

// 4. Analyse des jours 24-28/09 dans daily_summaries
const summaries = db.prepare(`
  SELECT day_key, yield_kwh, import_kwh, export_kwh
  FROM daily_summaries
  WHERE day_key BETWEEN '2026-09-23' AND '2026-09-28'
  ORDER BY day_key ASC
`).all();

console.log("\n📊 Bilans journaliers enregistrés en base :");
console.table(summaries);

// Cumul total mesuré par le compteur sur les 5.85 jours
if (cache && cache.meter) {
  const m = cache.meter.data;
  const totalCumulImport = m.importEnergy - m.importEnergyDayBase; // ~93.3 kWh
  const totalCumulExport = m.exportEnergy - m.exportEnergyDayBase; // ~78.1 kWh

  const missingDays = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'];
  // Retirer la part d'aujourd'hui (29/09)
  const remainingImport = Math.max(0, totalCumulImport - todayRealImport);
  const remainingExport = Math.max(0, totalCumulExport - todayRealExport);

  console.log(`\n🔋 Énergie réelle mesurée par le compteur sur les 5 jours (24-28/09) :`);
  console.log(`  - Import total à répartir : ${remainingImport.toFixed(1)} kWh (~${(remainingImport / 5).toFixed(1)} kWh/jour)`);
  console.log(`  - Export total à répartir : ${remainingExport.toFixed(1)} kWh (~${(remainingExport / 5).toFixed(1)} kWh/jour)`);

  // Répartition pondérée par la production solaire du jour
  const dayProds = {};
  let totalProd = 0;
  for (const day of missingDays) {
    const s = summaries.find(x => x.day_key === day);
    const y = s ? s.yield_kwh : 30;
    dayProds[day] = y;
    totalProd += y;
  }

  // Répartition équilibrée :
  // L'export dépend directement du surplus solaire (production élevée = plus d'export).
  // L'import est inversement lié au solaire (plus de soleil = moins d'import réseau pendant la journée, avec un talon de nuit constant).
  const proposedSummaries = missingDays.map(day => {
    const yieldKwh = dayProds[day];
    const prodShare = yieldKwh / totalProd;
    // Export proportionnel à la production solaire
    const expKwh = Math.round((remainingExport * prodShare) * 10) / 10;
    // Poids d'import : talon fixe (60%) + part variable inversement proportionnelle à la prod (40%)
    // Si prod faible (ex: 25/09 avec 18.2kWh), prodShare < 0.2 donc invShare > 0.2
    const invProdShare = (1 / totalProd) * (totalProd / missingDays.length * 2 - yieldKwh);
    const impWeight = 0.6 * (1 / missingDays.length) + 0.4 * Math.max(0.05, invProdShare);
    return { day, yieldKwh, expKwh, impWeight };
  });

  // Normaliser les imports pour que la somme soit exactement égale à remainingImport
  const totalImpWeight = proposedSummaries.reduce((acc, p) => acc + p.impWeight, 0);
  const finalProposed = proposedSummaries.map(p => {
    const impKwh = Math.round((remainingImport * (p.impWeight / totalImpWeight)) * 10) / 10;
    const solarUsed = Math.round(Math.max(0, p.yieldKwh - p.expKwh) * 10) / 10;
    const houseKwh = Math.round((solarUsed + impKwh) * 10) / 10;
    return {
      day_key: p.day,
      yield_kwh: p.yieldKwh,
      import_kwh: impKwh,
      export_kwh: p.expKwh,
      solar_used: solarUsed,
      house_kwh: houseKwh
    };
  });

  console.log("\n💡 Proposition de réparation des bilans journaliers (24 au 28/09) :");
  console.table(finalProposed);

  if (doFixToday) {
    console.log("\n🔧 Application du correctif pour AUJOURD'HUI dans solax-cache.json...");
    // Nouveau baseline pour aujourd'hui = index actuel moins l'énergie d'aujourd'hui
    const newImportBase = Math.round((m.importEnergy - todayRealImport) * 10) / 10;
    const newExportBase = Math.round((m.exportEnergy - todayRealExport) * 10) / 10;

    m.importEnergyDayBase = newImportBase;
    m.exportEnergyDayBase = newExportBase;
    m.dailyImport = todayRealImport;
    m.dailyExport = todayRealExport;

    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
    console.log(`✅ Cache mis à jour !`);
    console.log(`   importEnergyDayBase = ${newImportBase} kWh`);
    console.log(`   dailyImport = ${todayRealImport} kWh`);
    console.log(`   exportEnergyDayBase = ${newExportBase} kWh`);
    console.log(`   dailyExport = ${todayRealExport} kWh`);
  }

  if (doFixSummaries) {
    console.log("\n🔧 Application de la correction des bilans dans SQLite (daily_summaries)...");
    const stmtUpdate = db.prepare(`
      UPDATE daily_summaries
      SET import_kwh = @import_kwh, export_kwh = @export_kwh, updated_at = @now
      WHERE day_key = @day_key
    `);

    const now = Date.now();
    const updateTx = db.transaction(() => {
      for (const p of finalProposed) {
        stmtUpdate.run({
          day_key: p.day_key,
          import_kwh: p.import_kwh,
          export_kwh: p.export_kwh,
          now: now
        });
      }
    });
    updateTx();
    console.log(`✅ ${finalProposed.length} journées corrigées dans daily_summaries avec succès !`);
  }

  const doFixReadings = args.includes("--fix-readings");
  if (doFixReadings) {
    console.log("\n🔧 Reconstruction des courbes de puissance (power_readings) du 24 au 28/09...");
    const targetMap = {};
    for (const p of finalProposed) {
      targetMap[p.day_key] = p.house_kwh;
    }

    const stmtGetDayPts = db.prepare(`SELECT id, ts, pv_power FROM power_readings WHERE day_key = ? ORDER BY ts ASC`);
    const stmtUpdatePt = db.prepare(`UPDATE power_readings SET house_power = ?, grid_power = ? WHERE id = ?`);

    let totalUpdatedPts = 0;
    const updatePtsTx = db.transaction(() => {
      for (const day of missingDays) {
        const pts = stmtGetDayPts.all(day);
        if (!pts.length) continue;

        const targetKwh = targetMap[day] || 33;
        // Poids horaire typique résidentiel (24h)
        const hourWeights = [
          0.38, 0.35, 0.35, 0.35, 0.35, 0.38, // 00h-06h (talon nuit ~350W)
          0.60, 0.85, 0.75, 0.65, 0.60, 0.65, // 06h-12h (matin/repas)
          0.70, 0.60, 0.55, 0.60, 0.75, 0.95, // 12h-18h (après-midi)
          1.15, 1.25, 1.10, 0.85, 0.55, 0.42  // 18h-24h (soirée active)
        ];

        // Calculer l'intégrale actuelle brute avec ces poids
        let sumWeightDt = 0;
        for (let i = 1; i < pts.length; i++) {
          const dt = (pts[i].ts - pts[i-1].ts) / 3600000;
          if (dt <= 0 || dt > 0.5) continue;
          const h = new Date(pts[i].ts).getHours();
          sumWeightDt += hourWeights[h] * dt;
        }

        const scale = (targetKwh * 1000) / (sumWeightDt || 1);

        for (let i = 0; i < pts.length; i++) {
          const h = new Date(pts[i].ts).getHours();
          const houseEst = Math.round(hourWeights[h] * scale);
          const gridEst = Math.round(pts[i].pv_power - houseEst);
          stmtUpdatePt.run(houseEst, gridEst, pts[i].id);
          totalUpdatedPts++;
        }
      }
    });

    updatePtsTx();
    console.log(`✅ ${totalUpdatedPts} points horaires reconstitués avec succès dans power_readings !`);
  }
}

if (!doFixToday && !doFixSummaries && !args.includes("--fix-readings")) {
  console.log("\nℹ️  Mode simulation/analyse uniquement. Pour appliquer les modifications :");
  console.log("   node tools/fix-meter-blackout.js --fix-today      (Corrige l'affichage et le baseline d'aujourd'hui)");
  console.log("   node tools/fix-meter-blackout.js --fix-summaries  (Corrige les bilans journaliers 24-28/09 en base)");
  console.log("   node tools/fix-meter-blackout.js --fix-readings   (Reconstruit des courbes cohérentes dans power_readings)");
  console.log("   node tools/fix-meter-blackout.js --apply-all      (Applique fix-today et fix-summaries)");
}

console.log("\n==================================================================");

