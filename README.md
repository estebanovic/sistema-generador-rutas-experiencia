# Generador de Rutas (por experiencia de manejo)

Calcula rutas para auto/moto optimizando la **experiencia de manejo** (curvas,
superficie, tipo de vía) en lugar del tiempo. Construido sobre un grafo de
calles de OpenStreetMap con un Dijkstra ponderado propio.

## Stack

- **NestJS 11 + Mongoose** — almacén canónico por way (`osm_ways`, `osm_nodes`)
- **Overpass API** — descarga de calles de OpenStreetMap
- **Compilador propio** — grafo compactado en arrays tipados (CSR) con snapshot binario
- **Dijkstra propio** con nodos fantasma y costo configurable por perfil

## Requisitos

- Node 18+ (probado en Node 22)
- MongoDB corriendo localmente (`mongodb://localhost:27017`) o MongoDB Atlas

## Puesta en marcha

```bash
npm install
cp .env.example .env   # ajustá MONGO_URI si hace falta
npm run start:dev
```

Al arrancar se carga el grafo compilado desde `data/graph-cache/`, o se compila
desde Mongo si no hay snapshot para la versión de datos actual.

Reimportación masiva por teselas:

```bash
npm run build && node dist/cli/reimport-tiles.js --bbox <s>,<w>,<n>,<e>
```

## Endpoints

### `POST /import`

Descarga las calles de un bounding box, reemplaza los ways en el almacén y
recompila el grafo. Responde cuando el grafo ya incluye la zona.

```json
{ "south": -33.40, "west": -70.60, "north": -33.38, "east": -70.58 }
```

Respuesta: `{ nodes, edges, ways, deletedWays }`.

### `POST /routes/calculate`

```json
{
  "origin": { "lat": -33.45, "lon": -70.65 },
  "destination": { "lat": -33.35, "lon": -70.55 },
  "profile": "moto-curvas"
}
```

Perfiles: `moto-curvas`, `4x4`, `scenic`, `custom`. Con `custom` debés enviar
`customWeights`:

```json
{
  "origin": { "lat": -33.45, "lon": -70.65 },
  "destination": { "lat": -33.35, "lon": -70.55 },
  "profile": "custom",
  "customWeights": {
    "curvinessWeight": 3,
    "surfaceWeight": -2
  }
}
```

- `curvinessWeight` (0 a 4): cuánto se evitan las rectas.
- `surfaceWeight` (-4 a 4): mayor que 0 evita lo sin pavimentar; menor que 0 evita el pavimento (prefiere ripio y tierra).

Respuesta:

- `path`: osmIds de los nodos recorridos.
- `coordinates`: `[lat, lon]`; el primero y el último son el punto ajustado sobre la vía.
- `totalCost`: costo de la ruta en metros equivalentes (siempre ≥ la distancia; ver "Función de costo").
- `stats`: distancia, sinuosidad y desglose por tipo de vía y superficie. El desnivel es `null` porque no hay datos de elevación.
- `snap`: `{ origin, destination }`, cada uno `{ distanceMeters, lat, lon }`: el punto de la vía donde empieza o termina la ruta y su distancia al punto pedido.

Errores del ajuste (snap), con HTTP 404:

- la red conectada más cercana está a más de 1 km;
- el punto está en una isla sin conexión con el resto de la red;
- no hay vías importadas a menos de 5 km.

Sin camino (HTTP 400): origen y destino solo se conectan pasando por vías privadas.

### Cambios de contrato de la API

| Fecha | Cambio | Compatibilidad |
|---|---|---|
| 2026-10-18 | `stats.elevationGainMeters` y `stats.elevationLossMeters` pueden ser `null` (sin elevación). | Rompe a los clientes que asumen un número; el frontend ya muestra "sin datos". |
| 2026-10-18 | `POST /import` devuelve además `ways` y `deletedWays`. | Compatible (campos nuevos). |
| 2026-10-18 | Errores de snap nuevos: "fuera de la red conectada" y "sin camino sin pasar por vías privadas". | Compatible (mismos códigos HTTP). |
| 2026-10-18 | Campo `snap` en la respuesta de rutas; error si el ajuste supera 1 km. | El campo nuevo es compatible; el error de 1 km es un caso nuevo. |
| 2026-10-18 | `stats.curvinessDegPerKm` (°/km) y `stats.curvyShare` (fracción de metros ≥ 100 °/km); `stats.curviness` pasa a ser la sinuosidad normalizada nueva. | Compatible (campos nuevos; mismo rango [0,1]). |
| 2026-10-18 | `stats.surfaceSourceBreakdown`: metros por procedencia de la superficie (`declarada`, `tracktype`, `vecindad`, `tipo`). | Compatible (campo nuevo). |
| 2026-10-18 | `customWeights` solo admite `curvinessWeight` (0 a 4) y `surfaceWeight` (-4 a 4). `distanceWeight` y `elevationWeight` se eliminan: enviarlos responde 400. | Rompe a los clientes que usan el perfil `custom` (rango y campos nuevos). |
| 2026-10-18 | `totalCost` cambia de escala: ahora son metros equivalentes, ≥ `stats.distanceMeters`. Los perfiles predefinidos tienen pesos nuevos, así que sus rutas cambian. | Compatible en tipo; cambia el significado del número. |

## Función de costo

Cada segmento cuesta su largo `L` más recargos que nunca restan:

```
costo = L · (1 + curvinessWeight · rectitud + recargo de superficie) + 0,5 · L si es living_street o service
recargo de superficie = surfaceWeight · sinPavimentar          si surfaceWeight ≥ 0
                      = |surfaceWeight| · (1 − sinPavimentar)  si surfaceWeight < 0
```

- `rectitud` = 1 − min(1, densidad de giro / 100 °/km): 1 en una recta, 0 desde 100 °/km.
- `sinPavimentar`: asfalto y hormigón 0, adoquín 0,3, ripio, tierra y arena 1.
- Con los pesos en 0 la ruta es la más corta (salvo el recargo fijo de `living_street` y `service`).
- Con peso 4, una ruta más larga gana si cada 4 m extra ahorran al menos 1 m de lo que el perfil evita.

| Perfil | `curvinessWeight` | `surfaceWeight` | Presupuesto de desvío por defecto |
|---|---|---|---|
| moto-curvas | 3 | 0 | ×1,5 |
| 4x4 | 0 | -4 | ×2,0 |
| scenic | 4 | 2 | ×1,5 |

El presupuesto de desvío (largo de la ruta / distancia mínima) se usa por ahora para medir; el motor todavía no lo impone.

## Arquitectura

```
src/
  dijkstra/        motor puro (sin Nest): grafo compilado, costo, Dijkstra con nodos fantasma, snap, verificador de no repetición
  graph-compiler/  compilador puro: normalización de tags, derivación, compactación, CFC, puentes, gemelas, snapshot
  graph/           almacén por way (Mongo) + GraphService (carga el snapshot, recompila en un worker)
  osm/             OsmService (Overpass) + OsmParser (ways crudos)
  import/          import con reemplazo por way
  cli/             reimportación masiva por teselas
  routes/          endpoint de cálculo + perfiles de manejo
```

## Correcciones aplicadas sobre la guía original

> Sección histórica: describe el estado del proyecto antes del plan del motor
> (F0). Varias de estas piezas fueron reemplazadas después.

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
