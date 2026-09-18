import { z } from 'zod';

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Caminho em notacao de ponto. Rejeita __proto__/constructor/prototype em
 * qualquer segmento: `set(obj, '__proto__.x', v)` e prototype pollution real, e
 * o YAML e configuracao que pode vir de fora do time.
 */
export const dotPath = () =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        value
          .split('.')
          .every(
            (segment) => segment.length > 0 && !FORBIDDEN.has(segment.replace(/\[\d+\]$/, '')),
          ),
      { error: 'caminho invalido (segmento vazio ou reservado)' },
    );

export const httpMethod = () => z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const jsonScalar = () => z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const headerName = () =>
  z
    .string()
    .min(1)
    .regex(/^[A-Za-z0-9-]+$/, { error: 'nome de header invalido' });
