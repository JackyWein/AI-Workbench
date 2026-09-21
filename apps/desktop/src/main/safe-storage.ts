import { safeStorage } from "electron";
import type { SecretEncryption } from "@ai-workbench/credentials";

/**
 * The operating system's own secret storage (spec §57): the Keychain on macOS,
 * DPAPI on Windows, and libsecret through the desktop portal on Linux. When
 * none is usable this reports it instead of falling back to something weaker —
 * a secret the user believes is protected must never be stored in the clear.
 */
export class SafeStorageEncryption implements SecretEncryption {
  isAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  describe(): string {
    if (!this.isAvailable()) {
      return process.platform === "linux"
        ? "no secret service available (install gnome-keyring or kwallet)"
        : "the operating system reports no usable secret storage";
    }
    switch (process.platform) {
      case "darwin":
        return "macOS Keychain";
      case "win32":
        return "Windows DPAPI";
      default:
        return `Linux ${safeStorage.getSelectedStorageBackend()}`;
    }
  }

  encrypt(value: string): Buffer {
    return safeStorage.encryptString(value);
  }

  decrypt(value: Buffer): string {
    return safeStorage.decryptString(value);
  }
}
