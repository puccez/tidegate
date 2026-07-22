export function toIsoTimestamp(now: Date | string | undefined) {
  if (now instanceof Date) {
    return now.toISOString();
  }

  return now ?? new Date().toISOString();
}

export function createRegistryId(prefix: "branch" | "draft") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return value;
}
