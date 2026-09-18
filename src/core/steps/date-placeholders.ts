const PLACEHOLDER = /\{today(?:\s*([+-])\s*(\d+)d)?\}/g;

/** Data civil (ano/mes/dia) como ela e no fuso informado, no instante dado. */
function civilDate(instant: Date, timeZone: string): { y: number; m: number; d: number } {
  // en-CA formata como YYYY-MM-DD, que e exatamente o que precisamos.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  const [y, m, d] = formatted.split('-').map(Number);
  return { y: y ?? 1970, m: m ?? 1, d: d ?? 1 };
}

function addDaysIso(base: { y: number; m: number; d: number }, days: number): string {
  const shifted = new Date(Date.UTC(base.y, base.m - 1, base.d + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Resolve {today}, {today-2d} e {today+2d} no fuso do pipeline (default
 * America/Sao_Paulo), formato YYYY-MM-DD.
 *
 * O fuso importa de verdade: entre 21h e 00h em Brasilia, "hoje" em UTC ja e o
 * dia seguinte, e a janela de coleta consultaria a data errada todo fim de
 * tarde -- uma falha que so aparece em producao e so em parte do dia.
 */
export function resolveDatePlaceholders(template: string, now: Date, timeZone: string): string {
  if (!template.includes('{today')) return template;
  const base = civilDate(now, timeZone);
  return template.replace(
    PLACEHOLDER,
    (_match, sign: string | undefined, amount: string | undefined) => {
      if (sign === undefined || amount === undefined) return addDaysIso(base, 0);
      const days = Number(amount) * (sign === '-' ? -1 : 1);
      return addDaysIso(base, days);
    },
  );
}

export function resolveQueryPlaceholders(
  query: Readonly<Record<string, string>>,
  now: Date,
  timeZone: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    out[key] = resolveDatePlaceholders(value, now, timeZone);
  }
  return out;
}
