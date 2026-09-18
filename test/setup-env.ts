// O SDK do OpenTelemetry honra isto nativamente; nao ha flag propria a inventar.
process.env.OTEL_SDK_DISABLED = 'true';
process.env.TZ = 'America/Sao_Paulo';
process.env.NODE_ENV = 'test';
