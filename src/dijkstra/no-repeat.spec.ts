import { assertSinRepeticion, sinRepeticionViolations } from './no-repeat';
import { TramoUse } from './dijkstra';

const uso = (chain: number, s0: number, s1: number, dir: 1 | -1 = 1): TramoUse => ({ chain, s0, s1, dir });

describe('verificador RNF-SinRepetición', () => {
  it('tramos distintos: válido', () => {
    expect(sinRepeticionViolations([uso(1, 0, 100), uso(2, 0, 50)])).toEqual([]);
  });

  it('el mismo tramo dos veces, en cualquier sentido: inválido (la arista inversa comparte tramo)', () => {
    expect(sinRepeticionViolations([uso(1, 0, 100, 1), uso(1, 0, 100, -1)])).toHaveLength(1);
  });

  it('pedazos del mismo tramo sin superposición (nodos fantasma): válido', () => {
    expect(sinRepeticionViolations([uso(1, 0, 40, -1), uso(1, 60, 100, 1)])).toEqual([]);
    // Tocarse en un punto no es superponerse.
    expect(sinRepeticionViolations([uso(1, 0, 50), uso(1, 50, 100)])).toEqual([]);
  });

  it('pedazos que se superponen: inválido', () => {
    expect(sinRepeticionViolations([uso(1, 0, 60), uso(1, 40, 100, -1)])).toHaveLength(1);
  });

  it('acceso exento (D14): dos usos en sentidos opuestos sí; en el mismo sentido o tres veces no', () => {
    const ex = [{ chain: 7 }];
    expect(sinRepeticionViolations([uso(7, 0, 150, -1), uso(7, 0, 150, 1)], ex)).toEqual([]);
    expect(sinRepeticionViolations([uso(7, 0, 150, 1), uso(7, 0, 150, 1)], ex)).toHaveLength(1);
    expect(sinRepeticionViolations([uso(7, 0, 150, 1), uso(7, 0, 150, -1), uso(7, 0, 10, 1)], ex)).toHaveLength(1);
    // Sin la exención declarada, el mismo recorrido falla: la excepción es lo que lo permite.
    expect(() => assertSinRepeticion({ tramos: [uso(7, 0, 150, -1), uso(7, 0, 150, 1)] })).toThrow(/RNF-SinRepetición/);
  });
});
