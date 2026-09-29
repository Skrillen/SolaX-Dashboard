#!/usr/bin/env node
"use strict";

const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "data", "solax.db");
const db = new Database(DB_PATH);

// Données officielles issues de l'application SolaX
const officialData = [
  { day_key: '2026-09-23', yield_kwh: 33.70, import_kwh: 10.50, export_kwh: 18.40 },
  { day_key: '2026-09-24', yield_kwh: 18.20, import_kwh: 15.20, export_kwh: 10.40 },
  { day_key: '2026-09-25', yield_kwh: 32.20, import_kwh: 11.79, export_kwh: 13.09 },
  { day_key: '2026-09-26', yield_kwh: 32.10, import_kwh: 12.90, export_kwh: 15.80 },
  { day_key: '2026-09-27', yield_kwh: 31.10, import_kwh: 13.00, export_kwh: 15.50 },
  { day_key: '2026-09-28', yield_kwh: 25.30, import_kwh: 14.30, export_kwh: 12.89 },
];

console.log("==================================================================");
console.log("    Injection des données officielles de l'application SolaX      ");
console.log("==================================================================");

// 1. Mise à jour de daily_summaries
const stmtUpsertSummary = db.prepare(`
  INSERT INTO daily_summaries (day_key, yield_kwh, import_kwh, export_kwh, updated_at)
  VALUES (@day_key, @yield_kwh, @import_kwh, @export_kwh, @now)
  ON CONFLICT(day_key) DO UPDATE SET
    yield_kwh  = excluded.yield_kwh,
    import_kwh = excluded.import_kwh,
    export_kwh = excluded.export_kwh,
    updated_at = excluded.updated_at
`);

const now = Date.now();
const applyTx = db.transaction(() => {
  for (const row of officialData) {
    stmtUpsertSummary.run({ ...row, now });
  }
});
applyTx();
console.log(`✅ daily_summaries mis à jour avec les 5 journées officielles !`);

// 2. Harmonisation des power_readings pour que les courbes reflètent exactement la conso maison
const stmtGetPts = db.prepare(`SELECT id, ts, pv_power FROM power_readings WHERE day_key = ? ORDER BY ts ASC`);
const stmtUpdatePt = db.prepare(`UPDATE power_readings SET house_power = ?, grid_power = ? WHERE id = ?`);

// Poids horaire typique résidentiel (24h)
const hourWeights = [
  0.40, 0.38, 0.38, 0.38, 0.38, 0.42, // 00h-06h (talon nuit)
  0.65, 0.90, 0.80, 0.70, 0.65, 0.70, // 06h-12h (matin/repas)
  0.75, 0.65, 0.60, 0.65, 0.80, 1.00, // 12h-18h (après-midi)
  1.20, 1.30, 1.15, 0.90, 0.60, 0.45  // 18h-24h (soirée)
];

let totalPtsUpdated = 0;
const updateCurvesTx = db.transaction(() => {
  for (const day of officialData) {
    const pts = stmtGetPts.all(day.day_key);
    if (!pts.length) continue;

    // Conso maison officielle = (Yield - Export) + Import
    const solarUsed = Math.max(0, day.yield_kwh - day.export_kwh);
    const houseKwhTotal = solarUsed + day.import_kwh;

    // Intégrale de la pondération
    let sumWeightDt = 0;
    for (let i = 1; i < pts.length; i++) {
      const dt = (pts[i].ts - pts[i-1].ts) / 3600000;
      if (dt <= 0 || dt > 0.5) continue;
      const h = new Date(pts[i].ts).getHours();
      sumWeightDt += hourWeights[h] * dt;
    }

    const scale = (houseKwhTotal * 1000) / (sumWeightDt || 1);

    for (let i = 0; i < pts.length; i++) {
      const h = new Date(pts[i].ts).getHours();
      const houseEst = Math.round(hourWeights[h] * scale);
      const gridEst = Math.round(pts[i].pv_power - houseEst);
      stmtUpdatePt.run(houseEst, gridEst, pts[i].id);
      totalPtsUpdated++;
    }
  }
});
updateCurvesTx();
console.log(`✅ ${totalPtsUpdated} points de puissance (courbes) ajustés sur les totaux réels !`);

// 3. Vérification finale
console.log("\n📊 Récapitulatif des bilans en base (daily_summaries) :");
const summaries = db.prepare(`
  SELECT 
    day_key,
    yield_kwh,
    import_kwh,
    export_kwh,
    ROUND(yield_kwh - export_kwh + import_kwh, 2) as house_kwh,
    ROUND((yield_kwh - export_kwh) / yield_kwh * 100, 1) as autoconso_pct,
    ROUND((yield_kwh - export_kwh) / (yield_kwh - export_kwh + import_kwh) * 100, 1) as autarcie_pct
  FROM daily_summaries
  WHERE day_key >= '2026-09-20'
  ORDER BY day_key ASC
`).all();

console.table(summaries);
console.log("==================================================================");
