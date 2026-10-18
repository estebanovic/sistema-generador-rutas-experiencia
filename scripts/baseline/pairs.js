// Conjunto FIJO de pares origen-destino de la línea base (fijado el 2026-10-18,
// versión 2: todos los pares dentro de la cobertura). No modificar entre
// fases: si se agregan pares, hacerlo al final y anotarlo en el README.
// Coordenadas [lat, lon] aproximadas del centro de cada localidad; el snap del
// backend busca el camino más cercano.
const P = {
  plazaArmas: [-33.4378, -70.6505], providencia: [-33.4255, -70.6110], lasCondes: [-33.4140, -70.5830],
  laDehesa: [-33.3530, -70.5180], farellones: [-33.3560, -70.3120], maipu: [-33.5100, -70.7570],
  aeropuerto: [-33.3930, -70.7858], padreHurtado: [-33.5700, -70.8150], curacavi: [-33.4040, -71.1340],
  mariaPinto: [-33.5150, -71.1180],
  talagante: [-33.6640, -70.9290], buin: [-33.7320, -70.7420], pirque: [-33.6370, -70.5740],
  sanJoseMaipo: [-33.6420, -70.3530], sanAlfonso: [-33.7330, -70.2950], puenteAlto: [-33.6110, -70.5750],
  colina: [-33.2010, -70.6750], lampa: [-33.2860, -70.8760], penaflor: [-33.6060, -70.8770],
  elMonte: [-33.6800, -71.0170], islaMaipo: [-33.7520, -70.8970], caleraTango: [-33.6300, -70.7820],
  sanCristobal: [-33.4250, -70.6330], quilicura: [-33.3600, -70.7300], laFlorida: [-33.5220, -70.5980],
  valleNevado: [-33.3570, -70.2490],
};

const PAIRS = [
  ['plazaArmas', 'farellones'], ['laDehesa', 'farellones'], ['maipu', 'curacavi'], ['padreHurtado', 'curacavi'],
  ['curacavi', 'mariaPinto'], ['plazaArmas', 'curacavi'], ['talagante', 'curacavi'], ['providencia', 'sanCristobal'],
  ['quilicura', 'colina'], ['puenteAlto', 'sanJoseMaipo'], ['sanJoseMaipo', 'sanAlfonso'], ['pirque', 'buin'],
  ['buin', 'islaMaipo'], ['penaflor', 'elMonte'], ['colina', 'lampa'], ['lampa', 'aeropuerto'],
  ['providencia', 'maipu'], ['lasCondes', 'puenteAlto'], ['plazaArmas', 'providencia'], ['caleraTango', 'talagante'],
  ['colina', 'lasCondes'], ['farellones', 'valleNevado'], ['maipu', 'padreHurtado'], ['puenteAlto', 'pirque'],
  ['laFlorida', 'pirque'], ['laDehesa', 'colina'],
  ['lasCondes', 'farellones'], ['pirque', 'sanJoseMaipo'], ['maipu', 'lampa'], ['colina', 'aeropuerto'],
  ['puenteAlto', 'buin'], ['talagante', 'penaflor'], ['buin', 'caleraTango'],
];

// Segundo conjunto ("oferta", FIJO desde el 2026-10-18): 15 pares en zonas con
// oferta real de curvas y de caminos sin pavimentar, para medir el % del
// máximo alcanzable (D2) donde hay algo que alcanzar: precordillera (8),
// cuestas (3) y caminos rurales hacia la costa y Aculeo (4). Se eligieron entre
// 20 candidatos por su máximo alcanzable (ver el README). Mismas reglas que
// PAIRS: no modificar entre fases.
const P_OFERTA = {
  ...P,
  elYeso: [-33.6760, -70.0880], lagunillas: [-33.6158, -70.2992], banosMorales: [-33.8180, -70.0630],
  elAlfalfal: [-33.4950, -70.2050], elCanelo: [-33.5830, -70.4430], rioClarillo: [-33.7260, -70.4833],
  laParva: [-33.3320, -70.2900], yerbaLoca: [-33.3350, -70.3450], noviciado: [-33.4300, -70.8800],
  casablanca: [-33.3190, -71.4100], lasDichas: [-33.3000, -71.5600], melipilla: [-33.6890, -71.2150],
  sanPedro: [-33.8930, -71.4620], paine: [-33.8070, -70.7410], aculeo: [-33.8280, -70.9050],
  cuestaZapata: [-33.3700, -71.2500],
};

const PAIRS_OFERTA = [
  // Precordillera
  ['sanJoseMaipo', 'elYeso'], ['sanJoseMaipo', 'lagunillas'], ['sanAlfonso', 'banosMorales'], ['puenteAlto', 'elAlfalfal'],
  ['puenteAlto', 'elCanelo'], ['pirque', 'rioClarillo'], ['laDehesa', 'laParva'], ['laDehesa', 'yerbaLoca'],
  // Cuestas
  ['noviciado', 'curacavi'], ['curacavi', 'casablanca'], ['curacavi', 'cuestaZapata'],
  // Rurales hacia la costa y Aculeo
  ['casablanca', 'lasDichas'], ['melipilla', 'sanPedro'], ['paine', 'aculeo'], ['islaMaipo', 'aculeo'],
];

const SETS = { referencia: { P, PAIRS }, oferta: { P: P_OFERTA, PAIRS: PAIRS_OFERTA } };

const PROFILES = ['moto-curvas', '4x4', 'scenic'];

module.exports = { P, PAIRS, PROFILES, SETS };
