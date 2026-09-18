import { randomBytes, randomUUID } from 'node:crypto';
import type { IdGenerator } from '../core/ports/id-generator';

/**
 * UUIDv7 (RFC 9562): 48 bits de timestamp em milissegundos, 4 bits de versao,
 * 12 bits de sequencia aleatoria, 2 bits de variante, 62 bits aleatorios.
 *
 * Escrito aqui em vez de trazer uma dependencia: as bibliotecas de uuid
 * publicadas hoje sao ESM-only, e este projeto compila para CommonJS por
 * exigencia do OpenTelemetry (ver o comentario no topo de instrumentation.ts).
 * Sao quinze linhas e um formato estavel; a dependencia custaria mais.
 */
export function uuidV7(at: Date): string {
  const timestamp = at.getTime();
  const bytes = randomBytes(16);

  // 48 bits de timestamp, big-endian.
  bytes[0] = (timestamp / 2 ** 40) & 0xff;
  bytes[1] = (timestamp / 2 ** 32) & 0xff;
  bytes[2] = (timestamp / 2 ** 24) & 0xff;
  bytes[3] = (timestamp / 2 ** 16) & 0xff;
  bytes[4] = (timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  // Versao 7 nos 4 bits altos do byte 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // Variante RFC 4122 nos 2 bits altos do byte 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export class UuidGenerator implements IdGenerator {
  /**
   * O instante e EXPLICITO porque o id e o created_at precisam ser o mesmo:
   * gerar o id agora e deixar o banco preencher `now()` pode jogar os dois em
   * lados opostos de uma virada de mes, e a poda de particao derivada do id
   * passa a errar silenciosamente.
   */
  uuidV7(at: Date): string {
    return uuidV7(at);
  }

  uuid(): string {
    return randomUUID();
  }
}
