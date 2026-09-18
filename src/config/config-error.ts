import type { z } from 'zod';

export interface ConfigIssue {
  readonly file: string;
  readonly path: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(`configuracao invalida (${issues.length} erro(s))`);
    this.name = 'ConfigError';
    this.issues = issues;
  }

  static single(file: string, path: string, message: string): ConfigError {
    return new ConfigError([{ file, path, message }]);
  }
}

function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    return acc === '' ? String(segment) : `${acc}.${String(segment)}`;
  }, '');
}

/**
 * `z.prettifyError` serve para debug rapido, mas nao sabe o nome do arquivo nem
 * traduz `unrecognized_keys` -- e este e o texto que alguem vai ler as 3h da
 * manha. Mensagem de erro e interface de usuario; por isso ela tem teste de
 * string exata.
 */
function humanize(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys.join(', ');
    return `campo(s) nao reconhecido(s): ${keys}`;
  }
  if (issue.code === 'invalid_union') {
    return 'valor invalido para o discriminante';
  }
  return issue.message;
}

export function toIssues(file: string, error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => {
    const base = formatPath(issue.path);
    // unrecognized_keys aponta para o objeto; o campo ofensor esta em `keys`.
    const path =
      issue.code === 'unrecognized_keys' && issue.keys.length === 1
        ? [base, issue.keys[0]].filter(Boolean).join('.')
        : base;
    return { file, path, message: humanize(issue) };
  });
}

export function formatConfigError(error: ConfigError): string {
  const files = new Set(error.issues.map((i) => i.file));
  const lines = [
    `Configuracao invalida (${error.issues.length} erro(s) em ${files.size} arquivo(s)):`,
    '',
    ...error.issues.map((i) => `  ${i.file}: ${i.path === '' ? '<raiz>' : i.path}: ${i.message}`),
    '',
    'Nenhum pipeline foi iniciado.',
  ];
  return lines.join('\n');
}
