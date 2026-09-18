export type { RuntimeConfig } from './config/runtime-config';

/** Config de runtime congelada, injetada como useValue por AppModule.register. */
export const GATEWAY_RUNTIME = Symbol('GatewayRuntime');
export const GATEWAY_CONFIG = Symbol('GatewayConfig');
