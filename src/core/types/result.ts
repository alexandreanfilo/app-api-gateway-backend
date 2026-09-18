/**
 * Item rejeitado e DADO, nao falha de processo: vai para a auditoria e para a
 * resposta HTTP. Um `throw` no meio de um lote de 500 itens jogaria 499 itens
 * bons fora, por isso os steps devolvem Result em vez de lancar.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is { readonly ok: true; readonly value: T } {
  return r.ok;
}
