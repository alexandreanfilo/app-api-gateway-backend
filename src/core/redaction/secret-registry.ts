import { createHash } from 'node:crypto';

/** `***[a1b2c3d4]`: sem o fingerprint, todo incidente de auth vira adivinhacao
 *  ("o token que o parceiro manda e o mesmo do YAML?"). Com ele, a pergunta se
 *  responde sem nunca escrever o token. */
export function maskValue(value: string): string {
  return `***[${createHash('sha256').update(value).digest('hex').slice(0, 8)}]`;
}

/**
 * Rede de seguranca contra o vazamento que ninguem previu.
 *
 * Mascarar por NOME DE CHAVE nao pega uma URL montada por template string
 * (`...?jwt=eyJ...`) nem uma mensagem de erro do parceiro que ecoa o token de
 * volta. Aqui todo segredo resolvido e lembrado e removido de qualquer string
 * emitida.
 *
 * Piso de 8 caracteres para nao casar substring comum ("admin", "123").
 */
export class SecretRegistry {
  private static readonly MIN_LENGTH = 8;
  private readonly values = new Set<string>();

  remember(value: string): void {
    if (value.length >= SecretRegistry.MIN_LENGTH) this.values.add(value);
  }

  scrub(input: string): string {
    if (this.values.size === 0) return input;
    let out = input;
    for (const value of this.values) {
      if (out.includes(value)) out = out.split(value).join(maskValue(value));
    }
    return out;
  }

  get size(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }
}

/** Instancia de processo: o logger e o resolvedor de segredos compartilham. */
export const secretRegistry = new SecretRegistry();
