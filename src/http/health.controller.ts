import { Controller, Get, Inject } from '@nestjs/common';
import { sql } from 'kysely';
import { PIPELINE_REGISTRY, type PipelineRegistry } from '../config/pipeline-registry';
import { DATABASE, type Db } from '../persistence/database';

@Controller()
export class HealthController {
  constructor(
    @Inject(PIPELINE_REGISTRY) private readonly registry: PipelineRegistry,
    @Inject(DATABASE) private readonly db: Db,
  ) {}

  /** Liveness: o processo esta de pe. Nao toca em dependencia externa. */
  @Get('healthz')
  health(): Record<string, unknown> {
    return {
      status: 'ok',
      pipelines: this.registry.all.length,
      endpoints: this.registry.endpoints.map((p) => p.source.routePath),
      polls: this.registry.polls.map((p) => p.id),
    };
  }

  /** Readiness: da para aceitar trafego? Sem banco, nao da -- a garantia de
   *  nao perder evento e a linha no Postgres. */
  @Get('readyz')
  async ready(): Promise<Record<string, unknown>> {
    await sql`select 1`.execute(this.db);
    return { status: 'ready' };
  }
}
