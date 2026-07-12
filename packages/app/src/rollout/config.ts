export const TRACE_BINARY_CAPTURE_CONFIG_KEY =
  "trace_binary_capture_enabled" as const;

export interface FlatConfigSource {
  flatValues: Readonly<Record<string, unknown>>;
}

/** Binary capture is privacy-sensitive and is enabled only by literal `true`. */
export function resolveTraceBinaryCaptureEnabled(
  config?: FlatConfigSource | Readonly<Record<string, unknown>>
): boolean {
  if (!config) {
    return false;
  }
  const values: Readonly<Record<string, unknown>> = isFlatConfigSource(config)
    ? config.flatValues
    : config;
  return values[TRACE_BINARY_CAPTURE_CONFIG_KEY] === true;
}

function isFlatConfigSource(
  value: FlatConfigSource | Readonly<Record<string, unknown>>
): value is FlatConfigSource {
  const flatValues = (value as { flatValues?: unknown }).flatValues;
  return Boolean(
    flatValues && typeof flatValues === "object" && !Array.isArray(flatValues)
  );
}
