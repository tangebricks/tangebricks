import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The deploy's access key: one random value per deployment, kept between runs so that a second run uploads nothing new.
// It is stored in a git-ignored file and handed to the Worker as a secret binding. It never appears in a log or in evidence.

export interface KeyStore {
  read(): string | null;
  write(key: string): void;
}

export const memoryKeyStore = (initial: string | null = null): KeyStore => {
  let key = initial;
  return { read: () => key, write: (next) => void (key = next) };
};

export function fileKeyStore(path: string): KeyStore {
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8").trim() || null : null),
    write(key) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${key}\n`, { mode: 0o600 });
      try {
        chmodSync(path, 0o600); // a no-op on Windows, where the folder's own permissions apply
      } catch {
        // not supported on this file system
      }
    },
  };
}

/** The stored key, or a fresh 256-bit one (64 hexadecimal characters) that is stored before it is returned. */
export function loadOrCreateAccessKey(store: KeyStore, randomBytes: (n: number) => Uint8Array): string {
  const existing = store.read();
  if (existing && existing.length >= 32) return existing;
  const key = Buffer.from(randomBytes(32)).toString("hex");
  store.write(key);
  return key;
}
