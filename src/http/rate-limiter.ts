import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ensureConnected, REDIS } from '../redis.provider';

/**
 * Janela fixa por minuto, contada no Redis e nao em memoria: com N replicas, um
 * contador local multiplicaria o limite por N e `perMinute: 600` viraria 600
 * por instancia.
 *
 * Se o Redis estiver fora, a decisao e DEIXAR PASSAR. O limite existe para
 * proteger o gateway de um parceiro descontrolado, nao para ser a porta de
 * entrada: transformar indisponibilidade do Redis em 429 para todo mundo troca
 * um problema de capacidade por uma interrupcao de servico.
 */
@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly client: Redis) {}

  async allow(key: string, perMinute: number): Promise<boolean> {
    try {
      const client = await ensureConnected(this.client);
      const window = Math.floor(Date.now() / 60_000);
      const redisKey = `ratelimit:${key}:${window}`;
      const count = await client.incr(redisKey);
      if (count === 1) await client.expire(redisKey, 120);
      return count <= perMinute;
    } catch {
      return true;
    }
  }
}
