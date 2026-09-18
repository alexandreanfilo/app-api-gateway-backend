import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { TokenCache } from '../core/ports/token-cache';
import { ensureConnected, REDIS } from '../redis.provider';

/**
 * Cache do token de `login-token` em Redis, e nao em memoria.
 *
 * Com N replicas e cache local sao N logins por TTL contra a API do parceiro --
 * e o endpoint de login costuma ser justamente o de rate limit mais apertado.
 * Compartilhar o token mantem uma renovacao por TTL, independentemente de
 * quantas instancias existirem.
 */
@Injectable()
export class RedisTokenCache implements TokenCache {
  constructor(@Inject(REDIS) private readonly client: Redis) {}

  async get(key: string): Promise<string | undefined> {
    const client = await ensureConnected(this.client);
    return (await client.get(key)) ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const client = await ensureConnected(this.client);
    await client.set(key, value, 'EX', Math.max(ttlSeconds, 1));
  }

  async invalidate(key: string): Promise<void> {
    const client = await ensureConnected(this.client);
    await client.del(key);
  }
}
