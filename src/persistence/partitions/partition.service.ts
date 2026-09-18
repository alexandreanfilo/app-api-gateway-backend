import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { sql } from 'kysely';
import { LOGGER, type Logger } from '../../core/ports/logger';
import { METRICS, type Metrics } from '../../core/ports/metrics';
import { alreadySafe, maskError } from '../../core/redaction/mask';
import { DATABASE, type Db } from '../database';

const PARTITIONED_TABLES = ['pipeline_run', 'pipeline_delivery'] as const;

/**
 * pg_partman esta FORA de proposito: e uma extensao, e "um artefato, N
 * deployments" significa nao controlar se o Postgres do cliente a tem
 * disponivel (RDS e Cloud SQL tem; uma VM do cliente provavelmente nao, e
 * alguns exigem superuser para CREATE EXTENSION). Um artefato que so sobe em
 * metade dos ambientes nao e um artefato.
 */
@Injectable()
export class PartitionService implements OnApplicationBootstrap {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  /** Banco novo sobe funcionando, sem passo manual antes do primeiro request. */
  async onApplicationBootstrap(): Promise<void> {
    await this.ensureAll();
  }

  /**
   * Diario, nao mensal. Um cron mensal que falha no dia 1 se descobre em
   * producao; com janela de 3 meses a frente ha ~90 execucoes de folga antes de
   * qualquer dano.
   *
   * @Cron dispara em TODA instancia, mas a funcao plpgsql ja se protege com
   * pg_advisory_xact_lock -- aqui nao e preciso lock de aplicacao.
   */
  @Cron('17 3 * * *', { name: 'partition-maintenance' })
  async maintain(): Promise<void> {
    try {
      await this.ensureAll();
      await this.dropExpired();
      await this.checkDefaultPartitions();
    } catch (error) {
      this.logger.error('manutencao de particoes falhou', maskError(error));
    }
  }

  async ensureAll(): Promise<void> {
    const policies = await this.db.selectFrom('gw_partition_policy').selectAll().execute();
    for (const policy of policies) {
      const result = await sql<{ gw_ensure_month_partitions: string[] }>`
        SELECT gw_ensure_month_partitions(${policy.table_name}, 1, ${policy.months_ahead})
      `.execute(this.db);
      const created = result.rows[0]?.gw_ensure_month_partitions ?? [];
      if (created.length > 0) {
        this.logger.info('particoes criadas', alreadySafe({ table: policy.table_name, created }));
      }
      await this.db
        .updateTable('gw_partition_policy')
        .set({ last_ensured_at: new Date() })
        .where('table_name', '=', policy.table_name)
        .execute();
    }
  }

  async dropExpired(): Promise<void> {
    const policies = await this.db.selectFrom('gw_partition_policy').selectAll().execute();
    for (const policy of policies) {
      const result = await sql<{ gw_drop_old_partitions: string[] }>`
        SELECT gw_drop_old_partitions(${policy.table_name}, ${policy.keep_months})
      `.execute(this.db);
      const dropped = result.rows[0]?.gw_drop_old_partitions ?? [];
      if (dropped.length > 0) {
        this.logger.info('particoes removidas', alreadySafe({ table: policy.table_name, dropped }));
        await this.db
          .updateTable('gw_partition_policy')
          .set({ last_dropped_at: new Date() })
          .where('table_name', '=', policy.table_name)
          .execute();
      }
    }
  }

  /**
   * A particao DEFAULT e gratuita ENQUANTO VAZIA. Com linhas dentro, criar a
   * particao do mes seguinte exige ACCESS EXCLUSIVE sobre ela e um scan para
   * provar que nada dali pertence a faixa nova -- o que vira um lock de minutos
   * na maior tabela do sistema. Por isso a metrica, e o alerta em > 0.
   */
  async checkDefaultPartitions(): Promise<void> {
    for (const table of PARTITIONED_TABLES) {
      const result = await sql<{ total: number }>`
        SELECT count(*)::int AS total FROM ${sql.table(`${table}_default`)}
      `.execute(this.db);
      const total = result.rows[0]?.total ?? 0;
      this.metrics.defaultPartitionRows(total, { reason: table });
      if (total > 0) {
        this.logger.warn(
          'particao DEFAULT com linhas: criar a proxima particao vai exigir ACCESS EXCLUSIVE',
          alreadySafe({ table: `${table}_default`, rows: total }),
        );
      }
    }
  }
}
