/** Valores que atravessam o motor. Tudo que entra vira isto antes do primeiro step. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isJsonPrimitive(value: JsonValue | undefined): value is JsonPrimitive {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}
