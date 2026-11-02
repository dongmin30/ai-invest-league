let override: (() => number) | null = null;

/** Current epoch ms. All server code reads the clock through this so tests can pin it. */
export function now(): number {
  return override ? override() : Date.now();
}

/** Tests only: pin the clock (`setNow(() => t)`) or restore it (`setNow(null)`). */
export function setNow(fn: (() => number) | null): void {
  override = fn;
}
