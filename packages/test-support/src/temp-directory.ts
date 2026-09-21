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
 * JavaScript side is closed. A short retry covers that window; a directory
 * that still cannot be removed is left to the operating system rather than
 * failing an otherwise passing test, because it lives in the temp directory
 * and says nothing about the behaviour under test.
 *
 * The retry budget stays around a second on purpose. Node backs off linearly,
 * so a generous one runs past the test hook's own timeout and turns a tidy-up
 * into a failure of its own.
 */
export async function removeTempDirectory(directory: string): Promise<void> {
  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  } catch {
    // Left for the operating system to reclaim.
  }
}
