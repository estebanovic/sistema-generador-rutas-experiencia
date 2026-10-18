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

const PROFILES = ['moto-curvas', '4x4', 'scenic'];

module.exports = { P, PAIRS, PROFILES };
