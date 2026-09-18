import type { SecretResolver } from '../../core/ports/secret-resolver';
import { SecretUnavailableError } from '../../core/ports/secret-resolver';
import { type SecretRegistry, secretRegistry } from '../../core/redaction/secret-registry';
import { Secret } from '../../core/types/secret';

interface CacheEntry {
  readonly secret: Secret;
  readonly expiresAt: number;
}

/**
 * Implementacao inicial: le de variavel de ambiente.
 *
 * Trocar por AWS Secrets Manager depois e uma CLASSE NOVA que implementa
 * SecretResolver, sem tocar em nenhum YAML -- porque o YAML carrega apenas o
 * NOME LOGICO do segredo ({ secret: TSM_BEARER }), nunca um caminho de
 * provedor. Se alguem propuser `{ secret: 'arn:aws:secretsmanager:...' }`,
 * recuse: acopla a configuracao ao backend e quebra exatamente essa promessa.
 */
export class EnvSecretResolver implements SecretResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly registry: SecretRegistry = secretRegistry,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  async exists(name: string): Promise<boolean> {
    const value = this.env[name];
    return typeof value === 'string' && value.length > 0;
  }

  async resolve(name: string): Promise<Secret> {
    const cached = this.cache.get(name);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.secret;

    const value = this.env[name];
    if (value === undefined || value === '') {
      throw new SecretUnavailableError(name, this.describe());
    }

    const secret = new Secret(name, value);
    // Alimenta a rede de seguranca: a partir daqui, este valor e removido de
    // qualquer string que va para log ou auditoria, ainda que tenha chegado la
    // por um caminho que ninguem previu.
    this.registry.remember(value);
    this.cache.set(name, { secret, expiresAt: this.now() + this.ttlMs });
    return secret;
  }

  invalidate(name: string): void {
    this.cache.delete(name);
  }

  describe(): string {
    return 'variaveis de ambiente';
  }
}
