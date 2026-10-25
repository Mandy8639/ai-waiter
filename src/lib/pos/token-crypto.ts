import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption for POS OAuth tokens at rest (pos_credentials, see
 * 20261109090000_square_connection.sql). AES-256-GCM under a key that
 * lives in the deployment's secret store, so the database only ever holds
 * ciphertext.
 *
 * No `server-only` and no env reads: the key is passed in, so the round
 * trip and the tamper check are unit-tested (tests/unit/square-connection.test.ts).
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>", each part base64url. The version
 * prefix leaves room to rotate the algorithm or key without guessing what
 * an old row was written with.
 */

const VERSION = "v1";

export function parseTokenKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("POS_TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "POS_TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)",
    );
  }
  return key;
}

export function encryptToken(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((part) =>
      typeof part === "string" ? part : part.toString("base64url"),
    )
    .join(".");
}

export function decryptToken(sealed: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("Unrecognised token format");
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  // GCM's tag is what makes a flipped byte or a wrong key fail loudly
  // instead of decrypting to garbage that gets sent to Square.
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
