import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';
import { InboundAuthSchema, OutboundAuthSchema } from './auth.schema';
import { dotPath, httpMethod, jsonScalar } from './common';
import { TransformSchema } from './transform.schema';

/** Rotas do proprio app. Nenhum pipeline pode registrar path que colida com elas. */
const RESERVED_PREFIXES = ['healthz', 'readyz', 'metrics', 'admin'];

const cronExpression = () =>
  z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          CronExpressionParser.parse(value);
          return true;
        } catch {
          return false;
        }
      },
      { error: 'expressao cron invalida' },
    );

const timezone = () =>
  z.string().refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { error: 'fuso horario desconhecido' },
  );

// ---------------------------------------------------------------------------
// source: uniao discriminada estrita.
//
// E o `strictObject` que faz `schedule:` dentro de um http-endpoint virar
// unrecognized_keys. O requisito "rejeitar campo de poll dentro de endpoint"
// sai disso de graca, sem nenhum refinement escrito a mao -- e vale nos dois
// sentidos automaticamente.
// ---------------------------------------------------------------------------

const HttpPollSourceSchema = z.strictObject({
  kind: z.literal('http-poll'),
  schedule: cronExpression(),
  timezone: timezone().default('America/Sao_Paulo'),
  method: z.enum(['GET', 'POST']).default('GET'),
  url: z.url(),
  query: z.record(z.string().min(1), z.string()).default({}),
  headers: z.record(z.string().min(1), z.string()).default({}),
  auth: OutboundAuthSchema.default({ kind: 'none' }),
  pagination: z
    .strictObject({
      param: z.string().min(1),
      start: z.int().default(1),
      maxPages: z.int().min(1).max(1_000),
    })
    .optional(),
  itemsPath: dotPath().optional(),
  totalCountPath: dotPath().optional(),
  timeoutMs: z.int().min(100).max(300_000).default(30_000),
});

const HttpEndpointSourceSchema = z.strictObject({
  kind: z.literal('http-endpoint'),
  path: z
    .string()
    .min(1)
    .regex(/^\/?(in\/)?[a-z0-9][a-z0-9/_-]*$/, {
      error: 'path deve ser minusculo, com [a-z0-9/_-], sem barra final',
    })
    .refine((value) => !value.includes('//') && !value.includes('..'), {
      error: 'path nao pode conter // nem ..',
    })
    .refine(
      (value) => {
        const head = value.replace(/^\//, '').replace(/^in\//, '').split('/')[0] ?? '';
        return !RESERVED_PREFIXES.includes(head);
      },
      { error: `path colide com rota reservada do app (${RESERVED_PREFIXES.join(', ')})` },
    ),
  methods: z
    .array(z.enum(['POST', 'PUT', 'PATCH']))
    .nonempty()
    .default(['POST']),
  auth: InboundAuthSchema,
  itemsPath: dotPath().optional(),
  maxBodyBytes: z
    .int()
    .min(1)
    .max(64 * 1024 * 1024)
    .default(1024 * 1024),
  rateLimit: z.strictObject({ perMinute: z.int().min(1).max(600_000) }).optional(),
});

export const SourceSchema = z.discriminatedUnion('kind', [
  HttpPollSourceSchema,
  HttpEndpointSourceSchema,
]);

// ---------------------------------------------------------------------------

/**
 * Duas formas, e a curta continua valendo:
 *
 *   status: [NP, TP]                               # atalho para { in: [...] }
 *   numero_pedido: { numeric: true, notEquals: 0 } # predicados
 *
 * A forma com predicados existe porque o gateway antigo filtrava por VALIDADE
 * do campo, nao so por pertinencia a um conjunto.
 */
const FilterPredicatesSchema = z
  .strictObject({
    in: z.array(jsonScalar()).nonempty().optional(),
    notIn: z.array(jsonScalar()).nonempty().optional(),
    equals: jsonScalar().optional(),
    notEquals: jsonScalar().optional(),
    numeric: z.boolean().optional(),
    exists: z.boolean().optional(),
  })
  .refine((rule) => Object.values(rule).some((value) => value !== undefined), {
    error: 'informe ao menos um predicado (in, notIn, equals, notEquals, numeric, exists)',
  });

export const FilterSchema = z
  .record(
    dotPath(),
    z.union([z.array(jsonScalar()).nonempty(), FilterPredicatesSchema], {
      error: 'esperado uma lista de valores ou um objeto de predicados',
    }),
  )
  .default({});

export const DedupeSchema = z.strictObject({
  fields: z.array(dotPath()).default([]),
  /** So faz sentido em http-endpoint; validado no superRefine do pipeline. */
  header: z.string().min(1).optional(),
  onMissing: z.enum(['reject', 'generate']).optional(),
  ttlDays: z.int().min(1).max(3_650).default(90),
});

export const RetrySchema = z.strictObject({
  attempts: z.int().min(1).max(50).default(5),
  backoff: z.enum(['exponential', 'fixed']).default('exponential'),
  initialDelayMs: z.int().min(0).max(3_600_000).default(15_000),
  maxDelayMs: z.int().min(0).max(86_400_000).default(3_600_000),
  factor: z.number().min(1).max(10).default(2),
  jitter: z.number().min(0).max(1).default(0.2),
});

export const DestinationSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, { error: 'id deve ser kebab-case minusculo' }),
  method: httpMethod().default('POST'),
  url: z.url(),
  headers: z.record(z.string().min(1), z.string()).default({}),
  auth: OutboundAuthSchema.default({ kind: 'none' }),
  retry: RetrySchema.prefault({}),
  timeoutMs: z.int().min(100).max(300_000).default(30_000),
  successStatuses: z.array(z.int().min(100).max(599)).default([]),
  /** TRUNCATED por padrao: o corpo da entrega e a maior fonte de volume da tabela. */
  persistBody: z.enum(['FULL', 'TRUNCATED', 'HASH_ONLY']).default('TRUNCATED'),
  /** Opcional: o destino so recebe o evento quando o item casa (Content-Based Router). */
  filter: FilterSchema,
});

export const PipelineSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, { error: 'id deve ser kebab-case minusculo' }),
    name: z.string().min(1),
    client: z.string().min(1),
    enabled: z.boolean().default(true),
    /** ERRORS_ONLY existe porque a 600 req/min gravar tudo e ~860 mil linhas/dia. */
    runPersistence: z.enum(['ALL', 'ERRORS_ONLY']).default('ALL'),
    source: SourceSchema,
    filter: FilterSchema,
    dedupe: DedupeSchema.prefault({}),
    transform: TransformSchema,
    destinations: z.array(DestinationSchema).nonempty(),
  })
  .superRefine((pipeline, ctx) => {
    const destinationIds = new Set<string>();
    for (const [index, destination] of pipeline.destinations.entries()) {
      if (destinationIds.has(destination.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['destinations', index, 'id'],
          message: `destino '${destination.id}' duplicado no mesmo pipeline`,
        });
      }
      destinationIds.add(destination.id);
    }

    // A compatibilidade de `dedupe` com o tipo de entrada e validada AQUI em vez
    // de `dedupe` morar dentro do ramo da uniao. Se morasse la, o discriminante
    // de source.kind se propagaria para dentro do motor e todo consumidor de
    // dedupe teria de saber de onde o item veio.
    if (pipeline.source.kind === 'http-poll') {
      if (pipeline.dedupe.header !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['dedupe', 'header'],
          message: 'so e permitido quando source.kind = http-endpoint',
        });
      }
      if (pipeline.dedupe.fields.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['dedupe', 'fields'],
          message: 'obrigatorio para source.kind = http-poll (ao menos um campo)',
        });
      }
    } else {
      if (pipeline.dedupe.header === undefined && pipeline.dedupe.fields.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['dedupe'],
          message: 'informe dedupe.header e/ou dedupe.fields',
        });
      }
      if (pipeline.dedupe.onMissing === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['dedupe', 'onMissing'],
          message: "obrigatorio para source.kind = http-endpoint: 'reject' ou 'generate'",
        });
      }
    }
  });

/** SAIDA do parse: defaults ja aplicados, campos com .default() nao sao opcionais. */
export type PipelineConfig = z.infer<typeof PipelineSchema>;
/** ENTRADA: a forma do YAML, com os defaults ainda opcionais. Use em fixtures. */
export type PipelineYaml = z.input<typeof PipelineSchema>;
