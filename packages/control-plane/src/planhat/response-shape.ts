/**
 * Text-free structure of an unparseable Planhat MCP reply (#254, CS #278): field names and value types
 * only. Shared by the discovery and exact-Conversation transports.
 */
const SHAPE_KEY = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,39}$/;
const SHAPE_MAX_LENGTH = 1500;

/**
 * Describes a JSON value's structure without any of its values: object keys (only when they look
 * like field names), value types, array lengths and the shape of the first element. Strings are
 * reported as `string(<length>)`; a tool's `text` content is reported as JSON shape or `non-json`.
 */
export function describeResponseShape(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (typeof value === "string") return `string(${value.length})`;
  if (typeof value !== "object") return typeof value;
  if (depth >= 5) return Array.isArray(value) ? `array(${value.length})` : "object";
  if (Array.isArray(value)) {
    return value.length === 0
      ? "array(0)"
      : `array(${value.length})<${describeResponseShape(value[0], depth + 1)}>`;
  }
  const entries = Object.entries(value).slice(0, 30);
  const fields = entries.map(([key, field]) => {
    const name = SHAPE_KEY.test(key) ? key : "?";
    if (key === "text" && typeof field === "string")
      return `${name}:${describeText(field, depth + 1)}`;
    return `${name}:${describeResponseShape(field, depth + 1)}`;
  });
  const more = Object.keys(value).length > entries.length ? ",…" : "";
  return `{${fields.join(",")}${more}}`;
}

function describeText(text: string, depth: number): string {
  try {
    return `json-text<${describeResponseShape(JSON.parse(text) as unknown, depth)}>`;
  } catch {
    return `non-json-text(${text.length})`;
  }
}

export function shapeOf(value: unknown): string {
  const shape = describeResponseShape(value);
  return shape.length > SHAPE_MAX_LENGTH ? `${shape.slice(0, SHAPE_MAX_LENGTH)}…` : shape;
}
