# Generador de Rutas (por experiencia de manejo)

Calcula rutas para auto/moto optimizando la **experiencia de manejo** (curvas,
superficie, desnivel, tipo de vía) en lugar del tiempo. Construido sobre un grafo
de calles de OpenStreetMap con un Dijkstra ponderado propio.

## Stack

- **NestJS 11 + Mongoose** — almacenamiento del grafo (nodos y aristas)
- **Overpass API** — descarga de calles de OpenStreetMap
- **Open-Meteo API** — elevación SRTM
- **Dijkstra propio** con costo configurable por perfil

## Requisitos

- Node 18+ (probado en Node 22)
- MongoDB corriendo localmente (`mongodb://localhost:27017`) o MongoDB Atlas

## Puesta en marcha

```bash
npm install
cp .env.example .env   # ajustá MONGO_URI si hace falta
npm run start:dev
```

La app crea los índices de Mongo automáticamente al arrancar (incluido el
`2dsphere` para búsqueda de nodo cercano).

## Endpoints

### `POST /import`

Descarga las calles de un bounding box, las parsea, las enriquece con elevación
y las guarda en Mongo.

```json
{ "south": -33.40, "west": -70.60, "north": -33.38, "east": -70.58 }
```

> Empezá con un bounding box **pequeño**: Overpass es lento y la elevación se
> pide en lotes de 100 puntos.

### `POST /routes/calculate`

```json
{
  "origin": { "lat": -33.45, "lon": -70.65 },
  "destination": { "lat": -33.35, "lon": -70.55 },
  "profile": "moto-curvas"
}
```

Perfiles: `moto-curvas`, `4x4`, `scenic`, `custom`. Con `custom` debés enviar
`customWeights` (cada peso entre 0 y 1):

```json
{
  "origin": { "lat": -33.45, "lon": -70.65 },
  "destination": { "lat": -33.35, "lon": -70.55 },
  "profile": "custom",
  "customWeights": {
    "distanceWeight": 0.3,
    "curvinessWeight": 0.9,
    "elevationWeight": 0.2,
    "surfaceWeight": 0.4
  }
}
```

Respuesta: `path` (osmIds), `coordinates` (`[lat, lon]`), `totalCost` y `stats`
(distancia, desnivel acumulado y Sinuosidad media).

## Arquitectura

```
src/
  dijkstra/   algoritmo puro (types, cost, dijkstra) — sin dependencias de Nest
  graph/      schemas Mongo + GraphService (carga/cachea el grafo en memoria)
  osm/        OsmService (Overpass) + OsmParser (nodos/aristas/curviness)
  elevation/  ElevationService (Open-Meteo)
  import/     orquesta el pipeline completo
  routes/     endpoint de cálculo + perfiles de manejo
```

## Correcciones aplicadas sobre la guía original

La guía tenía varios errores que se corrigieron:

1. **Query de Overpass rota**: el regex `highway` tenía saltos de línea en medio,
   lo que invalida la consulta. Ahora va en una sola línea.
2. **Índice `2dsphere` inservible**: el `findNearestNode` con `$near` nunca
   funcionaría porque al guardar nodos no se poblaba `location.coordinates`.
   `upsertNodes` ahora setea `location: { type: 'Point', coordinates: [lon, lat] }`
   (orden GeoJSON, no `[lat, lon]`).
3. **`heap.pop()` sin guarda**: podía devolver `undefined` y romper el tipado;
   ahora se verifica antes de desestructurar.
4. **Reconstrucción de path frágil**: el `while (cur)` con `prev.get(cur)!` podía
   producir caminos inválidos. Ahora corta explícitamente en `startId` y valida
   que el camino empiece en el origen.
5. **`curviness` promediada mal**: se dividía por `path.length` (nodos) en vez de
   por la cantidad de aristas; además se elegía cualquier arista paralela. Ahora
   promedia sobre aristas y elige la más corta entre paralelas.
6. **Costo con penalizaciones `undefined`**: `SURFACE_PENALTY[surface]` daba `NaN`
   para valores fuera del mapa. Ahora hay defaults y un piso de costo positivo
   (Dijkstra requiere pesos > 0). Se incorporó además `smoothness` al costo, que
   la guía definía pero nunca usaba.
7. **Schemas extendiendo `Document`**: patrón deprecado que rompe el tipado en
   Mongoose 8. Se usa `HydratedDocument<T>` y un sub-schema GeoJSON real.
8. **DTO con `@IsEnum([...])`**: `@IsEnum` no valida arrays de literales; se usa
   `@IsIn(PROFILE_NAMES)`. Se agregó validación anidada de `customWeights`.
9. **Elevación en lotes de 1000**: la URL GET se excede; se bajó a 100 por
   request y se hace tolerante a fallos (devuelve 0 sin abortar la importación).
10. **`oneway` mal manejado**: ahora respeta `yes`/`-1`/`no` y asume sentido único
    en `motorway`; se deduplican aristas `(from,to,way)`.
```
