import type { LoggableError, Masked } from '../types/masked';

export const LOGGER = Symbol('Logger');

export type LogContext = Masked<Record<string, unknown>>;

/**
 * O contexto so aceita Masked. Nao ha sobrecarga que receba objeto cru -- e essa
 * ausencia que impede `logger.error('falhou', { headers: req.headers })`.
 */
export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Masked<LoggableError>, context?: LogContext): void;
  fatal(message: string, error?: Masked<LoggableError>, context?: LogContext): void;
}
