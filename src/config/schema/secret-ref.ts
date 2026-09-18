import { z } from 'zod';

export const RAW_SECRET_MESSAGE =
  'esperado { secret: REF } -- segredo em texto puro nao e permitido';

/**
 * TODO campo de credencial usa isto. Em nenhum lugar existe
 * `z.union([z.string(), secretRef()])`: e exatamente essa uniao que permitiria o
 * vazamento, porque aceitaria a senha literal no YAML sem reclamar.
 *
 * O parametro `error` (Zod 4 unificou message/invalid_type_error nele) e o que
 * faz uma string crua produzir a mensagem de dominio em vez de
 * "expected object, received string".
 */
export const secretRef = () =>
  z.strictObject(
    {
      secret: z
        .string()
        .min(1)
        .regex(/^[A-Z][A-Z0-9_]*$/, { error: 'REF deve ser SCREAMING_SNAKE_CASE' }),
    },
    {
      error: (issue) => (issue.code === 'invalid_type' ? RAW_SECRET_MESSAGE : undefined),
    },
  );

export type SecretRefInput = z.infer<ReturnType<typeof secretRef>>;

/** Chaves cujo valor e credencial, ainda que o schema nao saiba o nome de antemao. */
export const SENSITIVE_KEY = /(pass|senha|secret|token|key|credential|authorization)/i;
