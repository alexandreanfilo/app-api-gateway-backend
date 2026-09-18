import { z } from 'zod';
import { dotPath, headerName } from './common';
import { RAW_SECRET_MESSAGE, SENSITIVE_KEY, secretRef } from './secret-ref';

/**
 * Corpo do login. O schema nao sabe de antemao qual chave e a senha, entao a
 * heuristica de nome faz o trabalho: `password: "1234"` vira erro apontando
 * exatamente `source.auth.body.password`.
 */
const loginBody = () =>
  z.record(z.string().min(1), z.union([z.string(), secretRef()])).superRefine((body, ctx) => {
    for (const [key, value] of Object.entries(body)) {
      if (SENSITIVE_KEY.test(key) && typeof value === 'string') {
        ctx.addIssue({ code: 'custom', path: [key], message: RAW_SECRET_MESSAGE });
      }
    }
  });

/**
 * Autenticacao de SAIDA. Conjunto proprio, separado do de entrada.
 *
 * Um enum unico com todos os tipos permitiria `kind: login-token` na
 * autenticacao de um endpoint de entrada, e o verificador de entrada receberia
 * um caso que nao sabe tratar -- sem o compilador avisar. Com duas unioes,
 * `verifyInboundAuth(auth: InboundAuth)` e exaustivo de verdade.
 */
export const OutboundAuthSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('bearer'), token: secretRef() }),
  z.strictObject({
    kind: z.literal('basic'),
    username: z.string().min(1),
    password: secretRef(),
  }),
  z.strictObject({
    kind: z.literal('api-key'),
    header: headerName().default('X-Api-Key'),
    value: secretRef(),
  }),
  z.strictObject({
    kind: z.literal('login-token'),
    loginUrl: z.url(),
    method: z.enum(['POST', 'GET']).default('POST'),
    body: loginBody(),
    tokenPath: dotPath(),
    header: headerName().default('Authorization'),
    scheme: z.enum(['bearer', 'raw']).optional(),
    ttlSeconds: z.int().positive().max(86_400).default(3_600),
  }),
]);

/**
 * Autenticacao de ENTRADA. Hoje so `static-token`; `hmac` e `mtls` entram como
 * novos membros desta uniao, sem tocar em nada do que ja existe.
 */
export const InboundAuthSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('static-token'),
    header: headerName().default('Authorization'),
    scheme: z.enum(['bearer', 'raw']).optional(),
    value: secretRef(),
  }),
  // Pontos de extensao, deliberadamente fora de escopo nesta versao:
  //   { kind: 'hmac', header, algorithm, secret: secretRef(), toleranceSeconds }
  //   { kind: 'mtls', allowedSubjects: string[] }
]);

export type OutboundAuthInput = z.infer<typeof OutboundAuthSchema>;
export type InboundAuthInput = z.infer<typeof InboundAuthSchema>;
