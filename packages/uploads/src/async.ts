/**
 * Run `fn` over `values` with bounded concurrency, preserving input order
 * in the returned array. Used by multi-file attach (and similar fan-outs).
 */
export async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, values.length));
  const result = Array.from<R>({ length: values.length });
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await fn(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: limit }, worker));
  return result;
}
