const db = require('better-sqlite3')('data/solax.db');

// Récupérer TOUS les bilans pour les analyser
const summaries = db.prepare("SELECT day_key, yield_kwh FROM daily_summaries").all();

let fixed = 0;

for (const summary of summaries) {
  const dayKey = summary.day_key;
  const storedYield = summary.yield_kwh;
  
  // Obtenir les limites du jour en timestamp (ms)
  const [y, m, d] = dayKey.split('-').map(Number);
  const startTs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const endTs = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();

  const points = db.prepare(`SELECT ts, pv_power FROM power_readings WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`).all(startTs, endTs);

  if (points.length < 10) continue; // Pas assez de points pour calculer une courbe fiable

  let totalYield = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].ts - points[i - 1].ts) / 3600000; // heures
    if (dt > 0 && dt < 0.5) { // Éviter les trous énormes
      const avgProd = (Math.max(0, points[i].pv_power) + Math.max(0, points[i - 1].pv_power)) / 2;
      totalYield += avgProd * dt;
    }
  }

  const calculatedYield = Math.round((totalYield / 1000) * 10) / 10; // Arrondi 1 décimale

  // Si le rendement calculé via la courbe est supérieur de plus de 0.5 kWh à ce qui est en base (ce qui indique un bug d'enregistrement comme pour le 16, ou un 0)
  if (calculatedYield > storedYield + 0.5) {
    db.prepare("UPDATE daily_summaries SET yield_kwh = ? WHERE day_key = ?").run(calculatedYield, dayKey);
    console.log(`✅ ${dayKey} corrigé : Remplacé ${storedYield} par ${calculatedYield} kWh (calculé depuis ${points.length} points).`);
    fixed++;
  } else {
    console.log(`🆗 ${dayKey} OK : En base = ${storedYield} kWh, Calculé = ${calculatedYield} kWh.`);
  }
}

console.log(`\nTerminé ! ${fixed} jours corrigés avec succès.`);
