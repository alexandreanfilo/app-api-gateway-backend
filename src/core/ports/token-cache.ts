export const TOKEN_CACHE = Symbol('TokenCache');

/**
 * Cache do token de `login-token`. Precisa ser compartilhado entre instancias:
 * com N replicas e cache em memoria, sao N logins por TTL contra a API do
 * parceiro -- que costuma ter rate limit no endpoint de login.
 */
export interface TokenCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  invalidate(key: string): Promise<void>;
}
