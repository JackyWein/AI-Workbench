import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Creates a throwaway directory under the OS temp directory. */
export async function makeTempDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Removes a throwaway directory created for a test.
 *
 * Windows refuses to unlink a file while a handle is still open, and native
 * libraries such as libsql and node-pty release theirs a moment after the
 * JavaScript side is closed. Retrying covers that window. A directory that
 * still cannot be removed afterwards is left to the operating system rather
 * than failing an otherwise passing test: it lives in the temp directory and
 * says nothing about the behaviour under test.
 */
export async function removeTempDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Left for the operating system to reclaim.
  }
}
