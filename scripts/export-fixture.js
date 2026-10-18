// Exporta un subgrafo real de Mongo (solo lectura) como fixture de tests.
// Uso: node scripts/export-fixture.js <nombre> <south> <west> <north> <east>
// Deja test/fixtures/<nombre>.json con nodos y aristas cuyos dos extremos caen
// dentro del bbox. Formato compacto (arrays) para que el archivo sea chico.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const [name, ...nums] = process.argv.slice(2);
const [south, west, north, east] = nums.map(Number);
if (!name || nums.length !== 4 || nums.some((n) => Number.isNaN(Number(n)))) {
  console.error('Uso: node scripts/export-fixture.js <nombre> <south> <west> <north> <east>');
  process.exit(1);
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/generador-rutas');
  const db = mongoose.connection.db;
  const nodes = await db
    .collection('nodes')
    .find({ lat: { $gte: south, $lte: north }, lon: { $gte: west, $lte: east } }, { projection: { _id: 0, osmId: 1, lat: 1, lon: 1, elevation: 1 } })
    .toArray();
  const ids = new Set(nodes.map((n) => n.osmId));
  const edges = (
    await db
      .collection('edges')
      .find({ fromOsmId: { $in: [...ids] } }, { projection: { _id: 0, __v: 0 } })
      .toArray()
  ).filter((e) => ids.has(e.toOsmId));
  await mongoose.disconnect();

  // Orden estable para que el fixture sea reproducible.
  nodes.sort((a, b) => (a.osmId < b.osmId ? -1 : a.osmId > b.osmId ? 1 : 0));
  edges.sort((a, b) => `${a.fromOsmId}|${a.toOsmId}|${a.osmWayId}`.localeCompare(`${b.fromOsmId}|${b.toOsmId}|${b.osmWayId}`));

  const out = {
    meta: {
      name, bbox: { south, west, north, east }, exportedAt: new Date().toISOString(),
      nodeFields: ['osmId', 'lat', 'lon', 'elevation'],
      edgeFields: ['fromOsmId', 'toOsmId', 'distanceMeters', 'curviness', 'elevationGain', 'elevationLoss', 'highwayType', 'surface', 'smoothness', 'osmWayId'],
    },
    nodes: nodes.map((n) => [n.osmId, n.lat, n.lon, n.elevation ?? 0]),
    edges: edges.map((e) => [e.fromOsmId, e.toOsmId, e.distanceMeters, e.curviness, e.elevationGain, e.elevationLoss, e.highwayType, e.surface, e.smoothness, e.osmWayId ?? '']),
  };
  const file = path.join(__dirname, '..', 'test', 'fixtures', `${name}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`${file}: ${nodes.length} nodos, ${edges.length} aristas, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
})().catch((e) => { console.error(e); process.exit(1); });
