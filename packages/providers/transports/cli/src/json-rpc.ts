import type { Logger } from "@ai-workbench/shared";
import { startCli, type CliExit, type CliRun } from "./process.js";

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcError";
    this.code = code;
    this.data = data;
  }
}

export interface JsonRpcStdioOptions {
  readonly executablePath: string;
  readonly args: string[];
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Default per-request timeout. */
  readonly requestTimeoutMs?: number;
  readonly logger?: Logger;
  /**
   * Answers a request the other side sends us. Without a handler every such
   * request is declined with "method not found", which is the honest answer
   * for a client that only reads.
   */
  readonly onRequest?: (method: string, params: unknown) => Promise<unknown> | unknown;
  readonly onNotification?: (method: string, params: unknown) => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly method: string;
}

/**
 * JSON-RPC 2.0 over a child process's stdin and stdout, one message per line —
 * how several tools expose their own protocol (an app server, the Agent Client
 * Protocol). It is built on the same process layer as every other CLI call:
 * no shell, arguments as an array, and the process is stopped on close.
 *
 * Nothing here knows a method name. Callers speak the protocol; this only
 * moves messages and keeps requests and answers paired.
 */
export class JsonRpcStdioClient {
  readonly #run: CliRun;
  readonly #pending = new Map<number, Pending>();
  readonly #options: JsonRpcStdioOptions;
  readonly #reading: Promise<void>;
  #nextId = 1;
  #closed = false;
  #exit: CliExit | null = null;

  constructor(options: JsonRpcStdioOptions) {
    this.#options = options;
    this.#run = startCli({
      executablePath: options.executablePath,
      args: options.args,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      keepStdinOpen: true,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    this.#reading = this.#read();
    this.#run.completion
      .then((exit) => {
        this.#exit = exit;
        this.#failAll(
          new JsonRpcError(
            -32000,
            `The process exited${exit.code === null ? "" : ` with code ${exit.code}`}` +
              (exit.stderr.trim() ? `: ${firstLine(exit.stderr)}` : ""),
          ),
        );
      })
      .catch((error: unknown) => this.#failAll(error));
  }

  /** Sends a request and waits for its answer. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.#closed || this.#exit) {
      return Promise.reject(new JsonRpcError(-32000, "The connection is closed"));
    }
    const id = this.#nextId++;
    const limit = timeoutMs ?? this.#options.requestTimeoutMs ?? 30_000;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new JsonRpcError(-32001, `"${method}" did not answer within ${limit}ms`));
      }, limit);
      timer.unref?.();
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method,
      });
      this.#send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Stops the process and fails whatever is still waiting. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#failAll(new JsonRpcError(-32000, "The connection was closed"));
    this.#run.cancel();
    await this.#run.completion.catch(() => undefined);
    await this.#reading.catch(() => undefined);
  }

  #send(message: Record<string, unknown>): void {
    this.#run.write(`${JSON.stringify(message)}\n`);
  }

  async #read(): Promise<void> {
    for await (const line of this.#run.lines) {
      let message: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) {
          continue;
        }
        message = parsed as Record<string, unknown>;
      } catch {
        // Tools print banners and log lines on stdout too; they are not ours.
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message: Record<string, unknown>): void {
    const id = message["id"];
    const method = message["method"];

    if (typeof method === "string") {
      if (id === undefined || id === null) {
        this.#safely(() => this.#options.onNotification?.(method, message["params"]));
        return;
      }
      void this.#answer(id, method, message["params"]);
      return;
    }

    if (typeof id !== "number") {
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);

    const error = message["error"];
    if (error && typeof error === "object") {
      const { code, message: text, data } = error as {
        code?: unknown;
        message?: unknown;
        data?: unknown;
      };
      pending.reject(
        new JsonRpcError(
          typeof code === "number" ? code : -32603,
          typeof text === "string" ? text : `"${pending.method}" failed`,
          data,
        ),
      );
      return;
    }
    pending.resolve(message["result"]);
  }

  async #answer(id: unknown, method: string, params: unknown): Promise<void> {
    const handler = this.#options.onRequest;
    if (!handler) {
      this.#send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(method, params);
      this.#send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      this.#send({
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof JsonRpcError ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  #failAll(error: unknown): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #safely(run: () => void): void {
    try {
      run();
    } catch (error) {
      this.#options.logger?.debug("JSON-RPC notification handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}
