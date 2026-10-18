const mongoose = require('mongoose');
(async () => {
  await mongoose.connect('mongodb://localhost:27017/generador-rutas');
  const edges = await mongoose.connection.db
    .collection('edges')
    .find()
    .toArray();

  const curv = edges.map((e) => e.curviness);
  const buckets = { '0': 0, '0-0.05': 0, '0.05-0.1': 0, '0.1-0.2': 0, '0.2-0.4': 0, '>0.4': 0 };
  for (const c of curv) {
    if (c === 0) buckets['0']++;
    else if (c < 0.05) buckets['0-0.05']++;
    else if (c < 0.1) buckets['0.05-0.1']++;
    else if (c < 0.2) buckets['0.1-0.2']++;
    else if (c < 0.4) buckets['0.2-0.4']++;
    else buckets['>0.4']++;
  }

  const surf = {};
  const hw = {};
  for (const e of edges) {
    surf[e.surface] = (surf[e.surface] || 0) + 1;
    hw[e.highwayType] = (hw[e.highwayType] || 0) + 1;
  }

  console.log('Total aristas:', edges.length);
  console.log('Sinuosidad (distribución):', JSON.stringify(buckets));
  const maxCurv = curv.reduce((m, c) => (c > m ? c : m), 0);
  console.log('Sinuosidad max:', maxCurv.toFixed(3));
  console.log('Superficies:', JSON.stringify(surf));
  console.log('Tipos de vía:', JSON.stringify(hw));
  await mongoose.disconnect();
})();
