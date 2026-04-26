const DEFAULT_MAX_VISIBLE_CHARS = 200;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return normalized.includes("authorization")
    || normalized.includes("password")
    || normalized.includes("secret")
    || normalized.includes("cookie")
    || normalized.includes("token")
    || normalized.includes("apikey");
}

function truncateVisible(text: string, maxVisibleChars: number): string {
  if (text.length <= maxVisibleChars) return text;
  if (maxVisibleChars <= 3) return text.slice(0, maxVisibleChars);
  return `${text.slice(0, maxVisibleChars - 3)}...`;
}

function normalizeStructuredValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("Circular input");
    seen.add(value);
    const normalized = value.map((item) => normalizeStructuredValue(item, seen));
    seen.delete(value);
    return normalized;
  }

  if (typeof value === "object") {
    if (seen.has(value)) throw new Error("Circular input");
    seen.add(value);
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (isSensitiveKey(key)) output[key] = "[REDACTED]";
      else output[key] = normalizeStructuredValue(input[key], seen);
    }
    seen.delete(value);
    return output;
  }

  return null;
}

export function previewToolInput(value: unknown, maxVisibleChars = DEFAULT_MAX_VISIBLE_CHARS): string {
  if (typeof value === "string") return JSON.stringify("[STRING_INPUT]");
  try {
    const normalized = normalizeStructuredValue(value, new WeakSet<object>());
    return truncateVisible(JSON.stringify(normalized), maxVisibleChars);
  } catch {
    return JSON.stringify("[UNSERIALIZABLE_INPUT]");
  }
}
