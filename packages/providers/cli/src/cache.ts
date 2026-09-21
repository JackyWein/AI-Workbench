/**
 * One value that is expensive to learn — it means starting the tool — kept for
 * a while and learned only once at a time. The provider list asks for
 * installation and sign-in state on every refresh, and several views refresh
 * together; without this each of them would start its own process (spec §108:
 * do not spam providers).
 */
export class TimedCache<T> {
  readonly #ttlMs: number;
  readonly #now: () => number;
  #entry: { readonly value: T; readonly at: number } | null = null;
  #inFlight: Promise<T> | null = null;
  /** Bumped by `clear`, so a load that started before it cannot fill the cache. */
  #epoch = 0;

  constructor(ttlMs: number, now: () => number = Date.now) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  /** The cached value while it is fresh; otherwise one shared call to `load`. */
  get(load: () => Promise<T>): Promise<T> {
    if (this.#entry && this.#now() - this.#entry.at < this.#ttlMs) {
      return Promise.resolve(this.#entry.value);
    }
    if (this.#inFlight) {
      return this.#inFlight;
    }

    const epoch = this.#epoch;
    const pending = load().then(
      (value) => {
        if (epoch === this.#epoch) {
          this.#entry = { value, at: this.#now() };
        }
        return value;
      },
    );
    const settled = pending.finally(() => {
      if (this.#inFlight === settled) {
        this.#inFlight = null;
      }
    });
    this.#inFlight = settled;
    return settled;
  }

  /** Forgets the value, e.g. after the configuration changed. */
  clear(): void {
    this.#epoch += 1;
    this.#entry = null;
    this.#inFlight = null;
  }
}
