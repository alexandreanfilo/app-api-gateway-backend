import { Injectable, type LoggerService } from '@nestjs/common';
import { consola } from 'consola';
import type { LogContext, Logger } from '../core/ports/logger';
import type { LoggableError, Masked } from '../core/types/masked';

/**
 * ESTE E O UNICO ARQUIVO DO PROJETO QUE PODE IMPORTAR `consola`.
 *
 * A regra `only-logger-imports-consola` do dependency-cruiser garante isso, e
 * ela nao e burocracia: o primeiro `consola.error(err)` dentro de um catch
 * qualquer derrota todo o desenho de mascaramento, porque o objeto de erro do
 * undici carrega os headers da requisicao -- Authorization incluso.
 *
 * A assinatura so aceita Masked<...>, entao passar contexto cru nao compila.
 */
@Injectable()
export class AppLogger implements Logger, LoggerService {
  constructor(private readonly context = 'app') {}

  debug(message: string, context?: LogContext): void {
    consola.debug(this.format(message, context));
  }

  info(message: string, context?: LogContext): void {
    consola.info(this.format(message, context));
  }

  warn(message: string, context?: LogContext): void {
    consola.warn(this.format(message, context));
  }

  error(message: string, error?: Masked<LoggableError>, context?: LogContext): void {
    consola.error(this.format(message, context, error));
  }

  fatal(message: string, error?: Masked<LoggableError>, context?: LogContext): void {
    consola.fatal(this.format(message, context, error));
  }

  // ---- Adaptacao para o LoggerService do Nest ------------------------------
  // O Nest chama estes metodos com strings ja formadas por ele (boot, rotas,
  // DI). Nao ha objeto de dominio aqui, entao nao ha o que mascarar.
  log(message: unknown, ...optional: unknown[]): void {
    consola.info(this.nestMessage(message, optional));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    consola.debug(this.nestMessage(message, optional));
  }

  private nestMessage(message: unknown, optional: readonly unknown[]): string {
    const scope =
      typeof optional[optional.length - 1] === 'string'
        ? optional[optional.length - 1]
        : this.context;
    return `[${String(scope)}] ${typeof message === 'string' ? message : JSON.stringify(message)}`;
  }

  private format(
    message: string,
    context?: LogContext,
    error?: Masked<LoggableError>,
  ): Record<string, unknown> {
    return {
      message,
      context: this.context,
      ...(context !== undefined ? { data: context } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }
}

/** Instancia de processo, para os caminhos anteriores ao container do Nest. */
export const logger = new AppLogger('bootstrap');
