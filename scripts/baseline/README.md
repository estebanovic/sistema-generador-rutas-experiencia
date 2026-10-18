# Línea base del motor

Mide el motor con un conjunto fijo de 33 pares origen-destino × 3 perfiles. Se repite al cerrar cada fase del plan de desarrollo para comparar.

| Archivo | Qué hace |
|---|---|
| `pairs.js` | Pares y perfiles fijos. **No cambiar entre fases.** |
| `run.js` | Llama a `POST /routes/calculate` de la API corriendo y guarda las rutas (`raw.json`). |
| `metrics.js` | Calcula las métricas desde `raw.json` y Mongo, sin usar el código del motor. |
| `lib.js` | Carga del grafo, sinuosidad (°/km) y distancia mínima pura. |
| `results/` | Una carpeta por corrida. Se versionan `summary.json`, `metrics.json` y `report.txt`; `raw.json` (~1,2 MB) está en `.gitignore` y queda solo en local. |

## Cómo correrla

```bash
# 1. Backend levantado (desde cero, para medir el arranque en frío)
npm run build && npm run start:prod

# 2. En otra terminal: rutas → raw.json
node scripts/baseline/run.js scripts/baseline/results/AAAA-MM-DD-<fase>

# 3. Métricas → summary.json, metrics.json, report.txt
node --max-old-space-size=8192 scripts/baseline/metrics.js scripts/baseline/results/AAAA-MM-DD-<fase>
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
- **Rutas ≥ 70%:** cuántas rutas alcanzan el requisito del 70% del criterio.
- **Desvío:** distancia de la ruta / distancia mínima pura entre los mismos nodos de inicio y fin.
- **Solapamiento:** metros compartidos entre dos perfiles / largo de la más corta de las dos.
- **Rutas con tramos repetidos:** RNF-SinRepetición. Un segmento físico recorrido dos veces, en cualquier sentido.

## Cuándo hay que adaptar los scripts

- Si una fase cambia el **contrato de la API**, por ejemplo cuando F0.6 quita `tripLength`, se adapta solo `requestBody()` en `run.js` y se anota aquí.
- Si una fase cambia el **almacenamiento**, por ejemplo cuando F0.1 elimina la colección `edges`, se adapta `loadRaw()` en `lib.js`. Las métricas deben seguir calculándose igual.
- `metrics.js` interpreta `path` como lista de osmIds de nodos. Cuando el motor devuelva IDs de arista (F0.2), la respuesta debe seguir incluyendo la secuencia de osmIds o la geometría, para que la línea base siga siendo comparable.

## Historial de cambios de los scripts

- 2026-10-18 (v1): versión inicial. 33 pares; 6 fallaban por cobertura (Casablanca no importada, Melipilla desconectada).
- 2026-10-18 (v2, **conjunto fijo para todas las fases**): los 6 pares fallidos se reemplazaron por pares dentro de la cobertura: Plaza de Armas→Curacaví, Talagante→Curacaví, Providencia→Cerro San Cristóbal, Quilicura→Colina, Farellones→Valle Nevado y La Florida→Pirque. Referencia: `results/2026-10-18-linea-base/` (99/99 rutas OK).
