// Shared memory-kind labels. Kept dependency-free so plain UI tests can import it.
export const memoryKinds = { fact: '事实', preference: '偏好', commitment: '承诺' } as const;
export const kindLabel = (kind: string) => (memoryKinds as Record<string, string>)[kind] ?? kind;
