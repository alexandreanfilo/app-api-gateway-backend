import { createHash } from 'node:crypto';

const VALUE = Symbol('secret.value');

/**
 * Credencial resolvida. O valor so sai por `expose()`, o que torna trivial
 * auditar em code review todo ponto onde ele e materializado.
 *
 * As tres sobrescritas abaixo sao todas necessarias, cada uma cobre um caminho
 * de vazamento diferente:
 *  - toJSON              -> JSON.stringify (auditoria, resposta HTTP acidental,
 *                           e o job.data do BullMQ, que fica LEGIVEL no Redis)
 *  - inspect.custom      -> consola.log(obj) e console.dir
 *  - toString            -> template strings
 *
 * Cuidado com o efeito colateral de toString: `Bearer ${secret}` produz
 * "Bearer [secret:X]" em silencio em vez de quebrar. Por isso headers nunca sao
 * montados por interpolacao -- ver buildAuthHeaders() em core/steps/auth.ts,
 * que recebe Secret e chama expose() na ultima linha antes do envio.
 */
export class Secret {
  private readonly [VALUE]: string;

  constructor(
    readonly name: string,
    value: string,
  ) {
    this[VALUE] = value;
  }

  expose(): string {
    return this[VALUE];
  }

  /** 8 hex do sha256. Sem isto, todo incidente de auth vira adivinhacao. */
  fingerprint(): string {
    return createHash('sha256').update(this[VALUE]).digest('hex').slice(0, 8);
  }

  toString(): string {
    return `[secret:${this.name}]`;
  }

  toJSON(): string {
    return `[secret:${this.name}]`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `[secret:${this.name}]`;
  }
}

/** Referencia a um segredo, como aparece no YAML: { secret: TSM_BEARER }. */
export interface SecretRef {
  readonly secret: string;
}

export type MaybeSecret = string | Secret;

export function exposeHeaderValue(value: MaybeSecret): string {
  return value instanceof Secret ? value.expose() : value;
}
