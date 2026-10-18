/**
 * Puentes del multigrafo NO dirigido de tramos (Tarjan iterativo). Un tramo es
 * puente si al quitarlo el grafo se desconecta: es lo que define el acceso
 * exento del RNF-SinRepetición (D14). Se comparan IDs de tramo, no nodos, así
 * dos tramos paralelos entre los mismos nodos no son puentes. Un tramo-lazo
 * (mismo nodo en ambos extremos) nunca es puente.
 */
export function bridges(nodeCount: number, node0: Int32Array, node1: Int32Array): Uint8Array {
  const N = nodeCount;
  const T = node0.length;
  const start = new Int32Array(N + 1);
  for (let t = 0; t < T; t++) {
    start[node0[t] + 1]++;
    start[node1[t] + 1]++;
  }
  for (let i = 0; i < N; i++) start[i + 1] += start[i];
  const cursor = start.slice(0, N);
  const adj = new Int32Array(2 * T);
  for (let t = 0; t < T; t++) {
    adj[cursor[node0[t]]++] = t;
    adj[cursor[node1[t]]++] = t;
  }

  const isBridge = new Uint8Array(T);
  const disc = new Int32Array(N).fill(-1);
  const low = new Int32Array(N);
  const parentEdge = new Int32Array(N).fill(-1);
  const stackNode = new Int32Array(N);
  const stackPos = new Int32Array(N);
  let time = 0;

  for (let root = 0; root < N; root++) {
    if (disc[root] >= 0) continue;
    let sp = 0;
    disc[root] = low[root] = time++;
    stackNode[sp] = root;
    stackPos[sp] = start[root];
    sp++;
    while (sp > 0) {
      const u = stackNode[sp - 1];
      const pos = stackPos[sp - 1];
      if (pos < start[u + 1]) {
        stackPos[sp - 1] = pos + 1;
        const t = adj[pos];
        if (t === parentEdge[u]) continue;
        const v = node0[t] === u ? node1[t] : node0[t];
        if (disc[v] < 0) {
          disc[v] = low[v] = time++;
          parentEdge[v] = t;
          stackNode[sp] = v;
          stackPos[sp] = start[v];
          sp++;
        } else if (disc[v] < low[u]) {
          low[u] = disc[v];
        }
      } else {
        sp--;
        if (sp > 0) {
          const p = stackNode[sp - 1];
          if (low[u] < low[p]) low[p] = low[u];
          if (low[u] > disc[p]) isBridge[parentEdge[u]] = 1;
        }
      }
    }
  }
  return isBridge;
}
