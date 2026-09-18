import { z } from 'zod';
import { dotPath, jsonScalar } from './common';

const castKind = () =>
  z.enum([
    'string',
    'number',
    'integer',
    'boolean',
    'iso-date',
    'epoch-millis',
    'trim',
    'upper',
    'lower',
  ]);

/**
 * strictObject + superRefine, e NAO uma uniao de tres formatos.
 *
 * `z.union([{from,cast}, {const}, {from,default}])` parece mais limpo e produz a
 * pior mensagem possivel: tres conjuntos de issues aninhados sob invalid_union,
 * com o path da chave de destino perdido. Alem disso, a uniao proibiria sem
 * querer `{ from, default }` -- pegar da origem com fallback --, que e um caso
 * legitimo e comum.
 */
export const TransformRuleSchema = z
  .strictObject({
    from: dotPath().optional(),
    cast: castKind().optional(),
    const: jsonScalar().optional(),
    default: jsonScalar().optional(),
  })
  .superRefine((rule, ctx) => {
    const hasFrom = rule.from !== undefined;
    const hasConst = rule.const !== undefined;
    if (hasFrom === hasConst) {
      ctx.addIssue({ code: 'custom', message: 'informe exatamente um entre { from } e { const }' });
    }
    if (rule.cast !== undefined && !hasFrom) {
      ctx.addIssue({ code: 'custom', path: ['cast'], message: 'cast so e valido junto com from' });
    }
    if (rule.default !== undefined && !hasFrom) {
      ctx.addIssue({
        code: 'custom',
        path: ['default'],
        message: 'default so e valido junto com from',
      });
    }
  });

/** Chave = caminho de DESTINO em notacao de ponto, para aninhar sem sintaxe extra. */
export const TransformSchema = z.record(dotPath(), TransformRuleSchema);

export type TransformInput = z.infer<typeof TransformSchema>;
