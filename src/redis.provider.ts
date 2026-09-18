import type { Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { GATEWAY_RUNTIME, type RuntimeConfig } from './runtime.tokens';

export const REDIS = Symbol('Redis');

/**
 * Conexao Redis propria e explicita, separada da do BullMQ.
 *
 * O BullMQ 6 tornou o cliente Redis plugavel e nao expoe mais o seu; alem
 * disso, depender do cliente interno de uma fila para guardar token e limitar
 * taxa sempre foi acoplamento disfarcado de economia.
 */
export const redisProvider: Provider = {
  provide: REDIS,
  inject: [GATEWAY_RUNTIME],
  useFactory: (runtime: RuntimeConfig): Redis =>
    new Redis({
      host: runtime.redis.host,
      port: runtime.redis.port,
      db: runtime.redis.db,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    }),
};

export async function ensureConnected(client: Redis): Promise<Redis> {
  if (client.status === 'ready') return client;
  if (client.status === 'connecting' || client.status === 'connect') return client;
  await client.connect().catch(() => undefined);
  return client;
}
