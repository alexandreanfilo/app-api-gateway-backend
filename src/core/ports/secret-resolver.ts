import type { Secret } from '../types/secret';

export const SECRET_RESOLVER = Symbol('SecretResolver');

export class SecretUnavailableError extends Error {
  constructor(
    readonly secretName: string,
    where: string,
  ) {
    // A mensagem NUNCA inclui o valor, nem sequer um trecho dele.
    super(`segredo '${secretName}' nao encontrado em ${where}`);
    this.name = 'SecretUnavailableError';
  }
}

export interface SecretResolver {
  /**
   * Boot: o segredo existe? Nao devolve valor e nao o materializa.
   * Resolver tudo no boot encheria o heap de credenciais em texto puro (visiveis
   * em heap dump e core dump) e mataria rotacao; nao checar nada no boot faria o
   * pipeline quebrar as 2h da manha em vez de no deploy. Por isso as duas coisas,
   * com papeis diferentes.
   */
  exists(name: string): Promise<boolean>;
  /** Runtime: valor embrulhado, com cache de TTL curto para permitir rotacao. */
  resolve(name: string): Promise<Secret>;
  invalidate(name: string): void;
  /** Para mensagens de erro: 'variaveis de ambiente', 'AWS Secrets Manager (us-east-1)'. */
  describe(): string;
}
