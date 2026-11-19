export const COMPACT_DISCOVERY_OVERFLOW_RECORD_COUNT = 100_001;

export function compactDiscoveryOverflowJsonRpc(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    result: {
      structuredContent: {
        records: Array.from({ length: COMPACT_DISCOVERY_OVERFLOW_RECORD_COUNT }, () => 0),
      },
    },
  });
}
