import type {
  CompiledEndpointSource,
  CompiledPipeline,
  CompiledPollSource,
} from '../core/types/pipeline';

export const PIPELINE_REGISTRY = Symbol('PipelineRegistry');

export type EndpointPipeline = CompiledPipeline & { readonly source: CompiledEndpointSource };
export type PollPipeline = CompiledPipeline & { readonly source: CompiledPollSource };

/**
 * Construido ANTES do NestFactory, e injetado como useValue.
 *
 * Nao existe janela em que o Nest resolva rotas com o registry meio populado,
 * porque quando o container nasce ele ja esta pronto e congelado.
 */
export class PipelineRegistry {
  private readonly byPath = new Map<string, EndpointPipeline>();
  private readonly byId = new Map<string, CompiledPipeline>();

  constructor(pipelines: readonly CompiledPipeline[]) {
    for (const pipeline of pipelines) {
      this.byId.set(pipeline.id, pipeline);
      if (pipeline.source.kind !== 'http-endpoint') continue;
      this.byPath.set(pipeline.source.routePath, pipeline as EndpointPipeline);
    }
    Object.freeze(this);
  }

  lookupByPath(path: string): EndpointPipeline | undefined {
    return this.byPath.get(path.replace(/\/+$/, '').toLowerCase() || path.toLowerCase());
  }

  byIdOrUndefined(id: string): CompiledPipeline | undefined {
    return this.byId.get(id);
  }

  get all(): readonly CompiledPipeline[] {
    return [...this.byId.values()];
  }

  get endpoints(): readonly EndpointPipeline[] {
    return [...this.byPath.values()];
  }

  get polls(): readonly PollPipeline[] {
    return this.all.filter((p): p is PollPipeline => p.source.kind === 'http-poll');
  }
}
