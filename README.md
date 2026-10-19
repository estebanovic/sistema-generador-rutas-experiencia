# Generador de Rutas (por experiencia de manejo)

Calcula rutas para auto/moto optimizando la **experiencia de manejo** (curvas,
superficie, tipo de vía) en lugar del tiempo. Construido sobre un grafo de
calles de OpenStreetMap con un motor de caminos mínimos propio (A* sobre un costo ponderado).

## Stack

- **NestJS 11 + Mongoose** — almacén canónico por way (`osm_ways`, `osm_nodes`)
- **Overpass API** — descarga de calles de OpenStreetMap
- **Compilador propio** — grafo compactado en arrays tipados (CSR) con snapshot binario
- **A\* propio** (Dijkstra como oráculo en los tests) con nodos fantasma y costo configurable por perfil

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

## Tests y medición

```bash
npm test                    # Jest: motor, compilador, DTO y rutas doradas
npx jest test/golden -u     # actualiza las rutas doradas (solo si el cambio es intencional)
npm run build && npm run bench   # tiempo del motor y nodos asentados, en proceso
```

- **Rutas doradas** (`test/golden.spec.ts`): las 144 rutas de la línea base (los dos conjuntos de pares × 3 perfiles), calculadas sobre el grafo real como lo hace la API y congeladas en `test/__snapshots__/`. Un cambio que altere una ruta hace fallar el test hasta que se actualice el snapshot con `-u`. Necesitan el snapshot del grafo en `data/graph-cache/` (lo escribe el servidor al arrancar); si no está, se saltan con un aviso.
- **Verificador de no repetición:** todos los tests que calculan rutas pasan por `assertSinRepeticion`.
- **Bench** (`scripts/bench.js`): las mismas consultas, más una con los pesos en 0, repetidas `--reps` veces (5 por defecto), con A\* y con Dijkstra. Informa media, p50, p95 y máximo en ms, los nodos asentados, cuántas veces menos asienta A\* y la diferencia de costo entre ambos (debe ser 0). `--random N` agrega N pares al azar de 2–60 km; `--out archivo.json` guarda el resultado.
- **Línea base** (`scripts/baseline/`): métricas de calidad contra la API corriendo; ver su README.

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

- `curvinessWeight` (0 a 6): cuánto se evitan las rectas.
- `surfaceWeight` (-6 a 6): mayor que 0 evita lo sin pavimentar; menor que 0 evita el pavimento (prefiere ripio y tierra).

Opcional en cualquier perfil: `maxDetourRatio` (1,0 a 3,0), el presupuesto de desvío. La ruta no puede medir más que ese múltiplo de la ruta más corta entre los mismos puntos. Por defecto se usa el del perfil (ver "Función de costo"). Solo hay límite superior.

Respuesta:

- `path`: osmIds de los nodos recorridos.
- `coordinates`: `[lat, lon]`; el primero y el último son el punto ajustado sobre la vía.
- `totalCost`: costo de la ruta en metros equivalentes (siempre ≥ la distancia; ver "Función de costo").
- `stats`: distancia, sinuosidad (`curviness`, `curvinessDegPerKm`, `curvyShare`) y desglose por tipo de vía, superficie y procedencia de la superficie.
- `snap`: `{ origin, destination }`, cada uno `{ distanceMeters, lat, lon }`: el punto de la vía donde empieza o termina la ruta y su distancia al punto pedido.
- `detour`: el presupuesto de desvío aplicado.
  - `shortestDistanceMeters`: largo de la ruta más corta;
  - `detourRatio`: largo de la ruta / el de la más corta;
  - `maxDetourRatio`: el presupuesto usado;
  - `binding`: `true` si el presupuesto cambió la ruta;
  - `lambda` y `gap`: multiplicador de LARAC y brecha relativa con la cota inferior (0 si el presupuesto no ata). Con brecha > 0 puede existir una ruta factible algo mejor que la devuelta.

Errores del ajuste (snap), con HTTP 404:

- la red conectada más cercana está a más de 1 km;
- el punto está en una isla sin conexión con el resto de la red;
- no hay vías importadas a menos de 5 km.

Sin camino (HTTP 400): origen y destino solo se conectan pasando por vías privadas.

#### Longitud objetivo (`targetLengthKm`)

Con `targetLengthKm` (2 a 300) la ruta tiene esa longitud, ±15%, sin recorrer dos veces el mismo tramo:

- **Circuito:** sin `destination`, o con el destino en el mismo punto que el origen. Sale y vuelve al origen.

  ```json
  { "origin": { "lat": -33.64, "lon": -70.35 }, "profile": "moto-curvas", "targetLengthKm": 60 }
  ```

- **Destino fijo:** con `destination`. Llega al destino recorriendo aproximadamente esa longitud.

Si el origen está en una calle o un camino sin salida, el tramo hasta la red con ciclos se recorre de ida y de vuelta (acceso). El acceso repetido no puede superar el 25% del largo total. Si no existe un circuito (o el acceso superaría el 25%), se entrega una **ida y vuelta declarada**: hasta un punto de giro a la mitad de la longitud y de regreso por el mismo camino, marcada como tal. No se combina con `maxDetourRatio` (HTTP 400).

La respuesta trae, en lugar de `detour`, el bloque `targetLength`:

- `modalidad`: `circuito`, `ida-y-vuelta` o `ruta` (destino fijo);
- `targetMeters`, `tolerance` (0,15), `achievedMeters` y `withinBand`;
- `repeatedMeters` (lo recorrido dos veces) y `accessRepeatedMeters` (el acceso);
- en la ida y vuelta, `turnaround` (punto de giro), `message` y `circuitImpossible`: `true` si está demostrado que no existe un circuito, `false` si solo no se encontró;
- en la ruta con destino fijo, `message` si queda fuera de la banda;
- `waypoints`, `iterations` y `elapsedMs` de la búsqueda.

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
| 2026-10-18 | Se eliminan `stats.elevationGainMeters` y `stats.elevationLossMeters` (antes `null`): el backend ya no maneja elevación. | Rompe a los clientes que leen esos campos; el desnivel, si se muestra, lo obtiene el frontend por su cuenta. |
| 2026-10-18 | Se elimina `tripLength` (la "vuelta" con waypoints desviados): enviarlo responde 400. La ruta es siempre la directa del perfil. | Rompe a los clientes que lo envían, aunque sea `direct`. |
| 2026-10-18 | `GET /` ya no sirve el visor legado (`public/index.html`, D9); la vista es el frontend aparte. | Solo afecta a quien usaba ese visor. |
| 2026-10-18 | Campo opcional `maxDetourRatio` (1,0–3,0; por defecto el del perfil) y bloque `detour` en la respuesta. La ruta respeta siempre el presupuesto, así que puede cambiar donde la óptima lo excedía (en la línea base, La Dehesa→Colina en 4x4). | Compatible (campos nuevos); cambia la ruta solo donde el presupuesto ata. |
| 2026-10-18 | El peso máximo de `customWeights` sube de 4 a 6: `curvinessWeight` 0 a 6 y `surfaceWeight` -6 a 6 (D4). El perfil 4x4 pasa de `surfaceWeight` -4 a -6, así que algunas de sus rutas cambian. | Compatible para quien enviaba valores válidos; amplía el rango. |
| 2026-10-18 | Campo opcional `targetLengthKm` (2–300; F5): circuito sin `destination` o ruta con destino fijo, ±15%, sin repetir tramos. Con él, `destination` pasa a ser opcional; la respuesta trae `targetLength` en lugar de `detour`; no se combina con `maxDetourRatio` (400). | Compatible (campo nuevo); `detour` solo aparece en la ruta directa. |

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
- Con peso 6 (el máximo), una ruta más larga gana si cada 6 m extra ahorran al menos 1 m de lo que el perfil evita.

| Perfil | `curvinessWeight` | `surfaceWeight` | Presupuesto de desvío por defecto |
|---|---|---|---|
| moto-curvas | 3 | 0 | ×1,5 |
| 4x4 | 0 | -6 | ×2,0 |
| scenic | 4 | 2 | ×1,5 |

El presupuesto de desvío (largo de la ruta / distancia mínima) lo impone el motor con LARAC: si la ruta óptima del perfil lo excede, se busca la mejor que cabe, con una poda elíptica exacta. El usuario lo puede cambiar con `maxDetourRatio`.

## Arquitectura

```
src/
  dijkstra/        motor puro (sin Nest): grafo compilado, costo, búsqueda con nodos fantasma (A* y Dijkstra), presupuesto de desvío (LARAC), snap, routeVia con bloqueo de tramos, ILS con longitud objetivo y estructura de la red (puentes públicos, núcleo, cotas), verificador de no repetición
  graph-compiler/  compilador puro: normalización de tags, derivación, compactación, CFC, puentes, gemelas, snapshot
  graph/           almacén por way (Mongo) + GraphService (carga el snapshot en memoria compartida, recompila en un worker)
  osm/             OsmService (Overpass) + OsmParser (ways crudos)
  import/          import con reemplazo por way
  cli/             reimportación masiva por teselas
  routes/          endpoint de cálculo + perfiles de manejo + pool de workers de la ILS (ILS_WORKERS, por defecto 2)
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
