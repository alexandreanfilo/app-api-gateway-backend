import { type GatewayConfig, loadGatewayConfig } from './config/load-config';
import { EnvSecretResolver } from './config/secrets/env-secret-resolver';
import type { SecretResolver } from './core/ports/secret-resolver';

export interface BootstrapResult {
  readonly config: GatewayConfig;
  readonly secrets: SecretResolver;
}

/**
 * Fase 1 do boot: carregar, validar e compilar a configuracao ANTES de existir
 * qualquer container, pool ou socket.
 *
 * Isolado num modulo proprio para que os testes e2e montem a aplicacao pelo
 * mesmo caminho que producao, em vez de fabricarem uma config na mao que nunca
 * passou pelo validador.
 */
export async function bootstrapConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<BootstrapResult> {
  const secrets = new EnvSecretResolver(env);
  const config = await loadGatewayConfig({
    dir: env.PIPELINES_DIR ?? './pipelines',
    secrets,
    env,
  });
  return { config, secrets };
}
