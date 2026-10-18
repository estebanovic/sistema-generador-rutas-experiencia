# Línea base del motor

Mide el motor con dos conjuntos fijos de pares origen-destino × 3 perfiles. Se repite al cerrar cada fase del plan de desarrollo para comparar.

- **referencia** (33 pares): el conjunto original, mezcla de pares urbanos y rurales.
- **oferta** (15 pares): zonas con oferta real de curvas y de caminos sin pavimentar (precordillera, cuestas, caminos rurales hacia la costa y Aculeo).

| Archivo | Qué hace |
|---|---|
| `pairs.js` | Conjuntos de pares y perfiles fijos (`SETS.referencia`, `SETS.oferta`). **No cambiar entre fases.** |
| `run.js` | Llama a `POST /routes/calculate` de la API corriendo y guarda las rutas (`raw.json`). `--set oferta` elige el segundo conjunto. |
| `metrics.js` | Calcula las métricas desde `raw.json` y Mongo, sin usar el código del motor. |
| `lib.js` | Carga del grafo, sinuosidad (°/km), distancia mínima pura y máximo alcanzable (LARAC). |
| `results/` | Una carpeta por corrida. Se versionan `summary.json`, `metrics.json` y `report.txt`; `raw.json` (~1,2 MB) está en `.gitignore` y queda solo en local. |

## Cómo correrla

```bash
# 1. Backend levantado (desde cero, para medir el arranque en frío)
npm run build && npm run start:prod

# 2. En otra terminal: rutas → raw.json (los dos conjuntos)
node scripts/baseline/run.js scripts/baseline/results/AAAA-MM-DD-<fase>
node scripts/baseline/run.js scripts/baseline/results/AAAA-MM-DD-<fase>-oferta --set oferta

# 3. Métricas → summary.json, metrics.json, report.txt (cada carpeta, ~1,5 min)
node --max-old-space-size=8192 scripts/baseline/metrics.js scripts/baseline/results/AAAA-MM-DD-<fase>
node --max-old-space-size=8192 scripts/baseline/metrics.js scripts/baseline/results/AAAA-MM-DD-<fase>-oferta
```

- Mongo se toma de `MONGO_URI`, o de `mongodb://localhost:27017/generador-rutas` si no está definida.
- La API se toma del segundo argumento de `run.js`, o de `API_URL`, o de `http://localhost:3000`.
- `metrics.js` carga el grafo completo, unos 2 GB con la BD actual; de ahí el `--max-old-space-size`.

## Métricas

- **Tiempo:** el de la petición HTTP completa. La primera llamada incluye la carga del grafo si el servidor recién arrancó.
- **Criterio priorizado** (propuesta, decisión D1):
  - moto-curvas: % de metros con sinuosidad ≥ 100 °/km;
  - 4x4: % de metros sin pavimentar (declarado + inferido);
  - scenic: % de metros curvos y pavimentados.
  - La sinuosidad se calcula aquí, con la definición nueva (por way, W=100 m, θ=5°), igual en todas las fases.
- **Máximo alcanzable (D2):** la mayor fracción de metros que cumplen el criterio del perfil entre las rutas de la envolvente de LARAC (minimizar metros que no cumplen + λ·largo, para todo λ ≥ 0) con largo ≤ presupuesto × distancia mínima. La envolvente se recorre exacta (búsqueda paramétrica, ~7 vértices por par). Es una cota factible: una ruta del motor puede superarla levemente (% del máximo > 100%) por la brecha de dualidad.
- **Presupuesto por perfil (D5):** moto-curvas ×1,5, 4x4 ×2,0, scenic ×1,5 (`BUDGETS` en `metrics.js`, sobrescribible con `BASELINE_BUDGETS`).
- **% del máximo y rutas ≥ 70% del máximo (RNF07, D2):** criterio logrado / máximo alcanzable, solo en los pares con oferta (máximo ≥ 10%); los pares sin oferta se excluyen. Es el criterio de aceptación desde F2.
- **Rutas sobre el presupuesto:** desvío mayor que el presupuesto del perfil. Hasta F4 el motor no lo impone.
- **Rutas ≥ 70%** (absoluto): cuántas rutas alcanzan el 70% del criterio. Se mantiene por continuidad.
- **Desvío:** distancia de la ruta / distancia mínima pura entre los mismos nodos de inicio y fin.
- **Solapamiento** (informativo; dejó de ser criterio de aceptación en F2): metros compartidos entre dos perfiles / largo de la más corta de las dos.
- **Rutas con tramos repetidos:** RNF-SinRepetición. Un segmento físico recorrido dos veces, en cualquier sentido.

## Cuándo hay que adaptar los scripts

- Si una fase cambia el **contrato de la API**, por ejemplo cuando F0.6 quita `tripLength`, se adapta solo `requestBody()` en `run.js` y se anota aquí.
- Si una fase cambia el **almacenamiento**, por ejemplo cuando F0.1 elimina la colección `edges`, se adapta `loadRaw()` en `lib.js`. Las métricas deben seguir calculándose igual.
- `metrics.js` interpreta `path` como lista de osmIds de nodos. Cuando el motor devuelva IDs de arista (F0.2), la respuesta debe seguir incluyendo la secuencia de osmIds o la geometría, para que la línea base siga siendo comparable.

## Historial de cambios de los scripts

- 2026-10-18 (v1): versión inicial. 33 pares; 6 fallaban por cobertura (Casablanca no importada, Melipilla desconectada).
- 2026-10-18 (F0.1): `lib.js` lee por defecto el almacén por way (`osm_ways`/`osm_nodes`). La topología, con sentidos, exclusiones D7 y vías privadas solo de origen o destino, sale de `dist/graph-compiler`, así que antes hay que correr `npm run build`. La superficie sigue saliendo del tag crudo con el mapeo congelado. Las corridas anteriores (v2, F0.0) se reproducen con `BASELINE_SOURCE=legacy`.
- 2026-10-18 (v2, **conjunto fijo para todas las fases**): los 6 pares fallidos se reemplazaron por pares dentro de la cobertura: Plaza de Armas→Curacaví, Talagante→Curacaví, Providencia→Cerro San Cristóbal, Quilicura→Colina, Farellones→Valle Nevado y La Florida→Pirque. Referencia: `results/2026-10-18-linea-base/` (99/99 rutas OK).
- 2026-10-18 (F0.4): el compilador entrega la sinuosidad nueva. La columna "curvas métrica vieja" se recalcula en `lib.js` con la fórmula anterior a F0.4, para que siga siendo comparable entre fases. El criterio de moto-curvas usa la métrica nueva desde v1, así que no cambia.
- 2026-10-18 (F2, preparación):
  - **Máximo alcanzable (D2)** por ruta y presupuesto por perfil; `summary.json` agrega `budget`, `maxMean`, `pairsWithOffer`, `ofMaxMean`, `ofMaxMedian`, `routesAtLeast70OfMax` y `routesOverBudget`. Las métricas anteriores no cambian (verificado: 0 diferencias en las 99 rutas de F0.5).
  - **Conjunto `oferta`** (15 pares, fijo). Se eligió entre 20 candidatos por su máximo alcanzable; se descartaron San Alfonso→San Gabriel (corto y redundante con Baños Morales), El Monte→Melipilla, Talagante→Naltagua, Pomaire→Curacaví y Melipilla→María Pinto (oferta débil). Lagunillas y Río Clarillo se movieron sobre el camino (el punto original quedaba a más de 1 km); Leyda se descartó por la misma razón.
  - **Vías privadas en `lib.js`**, para seguir al motor: se replica D16 (las calles de enclave cuentan como privadas) y el nodo de inicio y el de fin siempre abren su acceso privado (con los nodos fantasma la ruta puede empezar a mitad de un tramo privado). Sin esto, Puente Alto→El Alfalfal no tenía camino en la línea base.
  - Referencia con D2: `results/2026-10-18-F0.5/` (regenerado) y `results/2026-10-18-F0.5-oferta/`.
- 2026-10-18 (F2): sin cambios en los scripts. `run.js` sigue enviando `tripLength: 'direct'` hasta F0.6. Resultados en `results/2026-10-18-F2/` y `results/2026-10-18-F2-oferta/`.
- 2026-10-18 (F0.6): `requestBody()` en `run.js` ya no envía `tripLength` (la API lo rechaza). Las rutas directas no cambian. Resultados en `results/2026-10-18-F0.6/` y `results/2026-10-18-F0.6-oferta/`.
- 2026-10-18 (F1): sin cambios en los scripts. Rutas idénticas a F0.6. `results/2026-10-18-F1/bench.json` guarda la referencia de `npm run bench` (tiempo del motor y nodos asentados) para comparar con A\* en F3.
- 2026-10-18 (F3): sin cambios en los scripts de calidad; la API usa A\*. Rutas idénticas a F1. `scripts/bench.js` compara ahora A\* con Dijkstra (tiempo, nodos asentados, diferencia de costo) y acepta `--random N` para pares al azar; referencias en `results/2026-10-18-F3/bench.json` (línea base, 5 repeticiones) y `bench-azar.json` (1.000 pares al azar, 1 repetición).
- 2026-10-18 (F4): sin cambios en los scripts de calidad; la API impone el presupuesto de desvío del perfil (LARAC). Cambia solo La Dehesa→Colina 4x4 (×2,09 → ×1,00); 0 rutas sobre el presupuesto. `scripts/bench.js` mide además la consulta completa con LARAC (búsquedas por consulta y cuántas veces ata); referencias en `results/2026-10-18-F4/bench.json` y `bench-azar.json`.
- 2026-10-18 (D4): sin cambios en los scripts. El perfil 4x4 pasa a `surfaceWeight` −6 (peso máximo 6). Cambian 9 rutas, todas de 4x4. Resultados en `results/2026-10-18-D4/` y `-D4-oferta/`.
- 2026-10-18 (F5, medición previa): `scripts/techo-estructural.js` mide el techo estructural de la red (si existe algún circuito sin repetir tramos por cada origen de los dos conjuntos, para 30, 60 y 100 km), en proceso sobre el snapshot. Resultados en `results/2026-10-18-F5-techo/` (`techo.json`, `report.txt`).
