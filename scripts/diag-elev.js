const mongoose = require('mongoose');
(async () => {
  await mongoose.connect('mongodb://localhost:27017/generador-rutas');
  const elevs = (
    await mongoose.connection.db.collection('nodes').find().toArray()
  ).map((n) => n.elevation);
  const zeros = elevs.filter((e) => e === 0).length;
  const real = elevs.filter((e) => e > 0);
  console.log(
    'Total nodos:',
    elevs.length,
    '| con elev real:',
    real.length,
    '| en 0:',
    zeros,
  );
  if (real.length) {
    console.log('Elevacion real min/max:', Math.min(...real), '/', Math.max(...real));
  }
  await mongoose.disconnect();
})();
