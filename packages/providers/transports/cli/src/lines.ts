/**
 * Assembles complete lines from arbitrary chunk boundaries. A CLI writing JSON
 * per line does not respect stream chunking, so a naive split loses or corrupts
 * events under load.
 */
export class LineAssembler {
  #buffer = "";

  push(chunk: string): string[] {
    this.#buffer += chunk;
    const parts = this.#buffer.split("\n");
    // The last element is either an incomplete line or an empty string.
    this.#buffer = parts.pop() ?? "";
    return parts.map(stripCarriageReturn).filter((line) => line.length > 0);
  }

  /** Returns whatever is left when the stream ends without a trailing newline. */
  flush(): string[] {
    const rest = stripCarriageReturn(this.#buffer);
    this.#buffer = "";
    return rest.length > 0 ? [rest] : [];
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/**
 * An async queue that lets a push-based source (a child process) feed a
 * pull-based consumer (`for await`) without losing items or deadlocking.
 */
interface Waiter<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
  readonly reject: (error: unknown) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<Waiter<T>> = [];
  #done = false;
  #error: unknown = null;

  push(item: T): void {
    if (this.#done) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  /** Ends the stream once buffered items have been consumed. */
  close(): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  /** Ends the stream with an error, after buffered items. */
  fail(error: unknown): void {
    if (this.#done) {
      return;
    }
    this.#done = true;
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.#items.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.#error !== null) {
        throw this.#error;
      }
      if (this.#done) {
        return;
      }
      const next = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.#waiters.push({ resolve, reject });
      });
      if (next.done) {
        return;
      }
      yield next.value;
    }
  }
}
