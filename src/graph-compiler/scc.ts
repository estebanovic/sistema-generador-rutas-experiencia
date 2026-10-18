/**
 * Componentes fuertemente conexas (Tarjan iterativo, sin recursión para no
 * desbordar la pila con ~1M de nodos) sobre un grafo en CSR.
 */
export interface SccResult {
  /** Componente de cada nodo. */
  comp: Int32Array;
  count: number;
  /** Id de la componente mayor y su tamaño. */
  largest: number;
  largestSize: number;
}

export function stronglyConnectedComponents(
  nodeCount: number,
  outStart: Int32Array,
  edgeTo: Int32Array,
): SccResult {
  const N = nodeCount;
  const order = new Int32Array(N).fill(-1);
  const low = new Int32Array(N);
  const onStack = new Uint8Array(N);
  const comp = new Int32Array(N).fill(-1);
  const stack = new Int32Array(N);
  let sp = 0;
  // Pila de llamadas explícita: pares (nodo, próxima arista a mirar).
  const callNode = new Int32Array(N);
  const callEdge = new Int32Array(N);
  let cp = 0;
  let counter = 0;
  let count = 0;

  for (let s = 0; s < N; s++) {
    if (order[s] >= 0) continue;
    order[s] = low[s] = counter++;
    stack[sp++] = s;
    onStack[s] = 1;
    callNode[cp] = s;
    callEdge[cp] = outStart[s];
    cp++;
    while (cp > 0) {
      const u = callNode[cp - 1];
      const p = callEdge[cp - 1];
      if (p < outStart[u + 1]) {
        callEdge[cp - 1] = p + 1;
        const v = edgeTo[p];
        if (order[v] < 0) {
          order[v] = low[v] = counter++;
          stack[sp++] = v;
          onStack[v] = 1;
          callNode[cp] = v;
          callEdge[cp] = outStart[v];
          cp++;
        } else if (onStack[v] && order[v] < low[u]) {
          low[u] = order[v];
        }
      } else {
        cp--;
        if (cp > 0) {
          const w = callNode[cp - 1];
          if (low[u] < low[w]) low[w] = low[u];
        }
        if (low[u] === order[u]) {
          let w: number;
          do {
            w = stack[--sp];
            onStack[w] = 0;
            comp[w] = count;
          } while (w !== u);
          count++;
        }
      }
    }
  }

  const sizes = new Int32Array(count);
  for (let i = 0; i < N; i++) sizes[comp[i]]++;
  let largest = -1;
  let largestSize = 0;
  for (let c = 0; c < count; c++) {
    if (sizes[c] > largestSize) {
      largest = c;
      largestSize = sizes[c];
    }
  }
  return { comp, count, largest, largestSize };
}
