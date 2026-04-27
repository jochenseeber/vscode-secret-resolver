import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Session-scoped cache for resolved 1Password values. Keys are hashed with
 * HMAC-SHA256 using the session key so the lookup is non-reversible from
 * the in-memory entry map alone. Values are encrypted with AES-256-GCM
 * using the same session key plus a fresh per-entry IV. `clear()` zeroes
 * the session key buffer and rotates to a fresh key, dropping all entries
 * atomically.
 *
 * The session key lives in a closure-scoped `Buffer` rather than as a
 * `string`, so accidental `JSON.stringify` / `inspect` of the cache object
 * does not surface the material. This is obfuscation, not real encryption:
 * an attacker with extension-host code execution has both the key and the
 * ciphertext in the same heap. Treat it as defense against heap dumps and
 * accidental log disclosure, not against a determined attacker.
 */
export class SecretCache {
    #sessionKey: Buffer;
    #entries: Map<string, Buffer>;

    constructor() {
        this.#sessionKey = randomBytes(KEY_BYTES);
        this.#entries = new Map();
    }

    /**
     * Returns the cached plaintext for `opRef`, or `undefined` if not
     * cached.
     */
    get(opRef: string): string | undefined {
        const blob = this.#entries.get(this.#hashKey(opRef));

        if (blob === undefined) {
            return undefined;
        }

        return this.#decrypt(blob);
    }

    /**
     * Stores `value` under the obfuscated form of `opRef`. Overwrites any
     * existing entry.
     */
    set(opRef: string, value: string): void {
        this.#entries.set(this.#hashKey(opRef), this.#encrypt(value));
    }

    /**
     * Drops all cached entries and rotates the session key. The previous
     * key buffer is zeroed before being replaced — defensive memory hygiene
     * so a heap dump captured between rotation and GC sees zeros, not the
     * old key. After this returns, any subsequent `get` for a previously-
     * set ref returns `undefined`.
     */
    clear(): void {
        this.#sessionKey.fill(0);
        this.#sessionKey = randomBytes(KEY_BYTES);
        this.#entries = new Map();
    }

    #hashKey(opRef: string): string {
        return createHmac("sha256", this.#sessionKey)
            .update(opRef)
            .digest("hex");
    }

    #encrypt(plaintext: string): Buffer {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", this.#sessionKey, iv);
        const ciphertext = Buffer.concat([
            cipher.update(plaintext, "utf8"),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, ciphertext]);
    }

    #decrypt(blob: Buffer): string {
        const iv = blob.subarray(0, IV_BYTES);
        const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
        const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
        const decipher = createDecipheriv("aes-256-gcm", this.#sessionKey, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]).toString("utf8");
    }
}
