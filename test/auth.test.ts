import assert from "node:assert/strict";
import { describe, it } from "node:test";

import bcrypt from "bcryptjs";

import type * as NormalizeModule from "../lib/auth/normalize";
import type * as PasswordModule from "../lib/auth/password";

/**
 * Run with:  npm test   (node --experimental-strip-types --test test/*.test.ts)
 *
 * Deliberately covers only the dependency-free half of the auth code. Anything
 * importing `@/lib/db` needs a live Postgres and the `@/` path alias, neither
 * of which plain `node --test` provides — those paths are exercised by actually
 * signing in, not here.
 *
 * The split import style below is not decoration. Two tools disagree:
 *
 *   - Node's type stripping does NO module resolution. It will not map
 *     `./x.js` onto `./x.ts`, so at runtime the specifier must end in `.ts`.
 *   - `tsconfig.json` does not set `allowImportingTsExtensions`, so a literal
 *     `.ts` specifier is a compile error (TS5097).
 *
 * So: types come from the extensionless path (erased before Node sees it,
 * resolved fine by moduleResolution "bundler"), and the values come from a
 * dynamic import whose specifier is a variable, which TypeScript does not try
 * to resolve. Full type checking, and it actually runs.
 */

const normalizeSpecifier = "../lib/auth/normalize.ts";
const passwordSpecifier = "../lib/auth/password.ts";

const { normalizeEmail, normalizeIdentifier } = (await import(
  normalizeSpecifier
)) as typeof NormalizeModule;

const {
  BCRYPT_ROUNDS,
  MAX_PASSWORD_BYTES,
  hashPassword,
  passwordByteLength,
  verifyPassword,
} = (await import(passwordSpecifier)) as typeof PasswordModule;

describe("password hashing", () => {
  it("round-trips a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  });

  it("rejects the wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("Correct horse battery staple", hash), false);
    assert.equal(await verifyPassword("", hash), false);
  });

  it("uses the configured cost factor and a fresh salt each time", async () => {
    const a = await hashPassword("same-input");
    const b = await hashPassword("same-input");
    assert.notEqual(a, b, "two hashes of one password must differ (random salt)");
    assert.match(a, new RegExp(`^\\$2[aby]\\$${BCRYPT_ROUNDS}\\$`));
    // Both still verify despite differing.
    assert.equal(await verifyPassword("same-input", a), true);
    assert.equal(await verifyPassword("same-input", b), true);
  });

  /**
   * THE case this app actually has to get right: password_hash is NULLABLE,
   * because a magic-link-only user never sets one. That must fail the check
   * cleanly, not throw — a throw inside authorize() is reported to the user as
   * a server configuration error instead of a failed login.
   */
  describe("NULL password_hash (magic-link-only user)", () => {
    for (const [label, stored] of [
      ["null", null],
      ["undefined", undefined],
      ["empty string", ""],
    ] as const) {
      it(`returns false without throwing for ${label}`, async () => {
        const result = await verifyPassword("anything at all", stored);
        assert.equal(result, false);
      });
    }

    it("does not throw on a corrupt/non-bcrypt digest", async () => {
      assert.equal(await verifyPassword("hunter2", "not-a-bcrypt-hash"), false);
      assert.equal(await verifyPassword("hunter2", "$2b$12$tooshort"), false);
    });

    it("burns comparable time to a real mismatch, so NULL is not a timing oracle", async () => {
      const hash = await hashPassword("a-real-password");

      const t0 = performance.now();
      await verifyPassword("wrong-password", hash);
      const mismatchMs = performance.now() - t0;

      const t1 = performance.now();
      await verifyPassword("wrong-password", null);
      const nullMs = performance.now() - t1;

      // Same order of magnitude is the claim — not equality. A NULL path that
      // returned instantly would be ~1000x faster and would fail this.
      assert.ok(
        nullMs > mismatchMs / 4,
        `NULL path (${nullMs.toFixed(1)}ms) returned far faster than a real mismatch (${mismatchMs.toFixed(1)}ms)`,
      );
    });
  });

  it("agrees with a hash produced independently by bcryptjs", async () => {
    const external = bcrypt.hashSync("externally-hashed", 10);
    assert.equal(await verifyPassword("externally-hashed", external), true);
    assert.equal(await verifyPassword("externally-hashed!", external), false);
  });
});

describe("bcrypt 72-byte ceiling", () => {
  it("counts bytes, not characters", () => {
    assert.equal(passwordByteLength("abc"), 3);
    assert.equal(passwordByteLength("é"), 2);
    assert.equal(passwordByteLength("🂡"), 4);
  });

  /**
   * Documents WHY the schema caps length: bcrypt silently truncates at 72
   * bytes, so without the cap these two distinct passwords would be
   * interchangeable. This test asserts the underlying library behaviour, which
   * is the justification for the validation rule.
   */
  it("proves truncation is real, which is what the cap exists to prevent", async () => {
    const base = "x".repeat(MAX_PASSWORD_BYTES);
    const hash = await hashPassword(base);
    assert.equal(await verifyPassword(`${base}-totally-different-tail`, hash), true);
  });
});

describe("email normalisation", () => {
  it("lowercases and trims", () => {
    assert.equal(normalizeEmail("  Bob@Example.COM \n"), "bob@example.com");
  });

  it("maps the casings that LOWER(email) treats as one row to one string", () => {
    const spellings = ["bob@example.com", "Bob@Example.com", "BOB@EXAMPLE.COM", " bob@example.com "];
    const normalised = new Set(spellings.map(normalizeEmail));
    assert.equal(
      normalised.size,
      1,
      "users_email_key is UNIQUE on LOWER(email); these must collapse to one value",
    );
  });

  it("keeps the local part intact apart from case", () => {
    assert.equal(normalizeEmail("First.Last+tag@Example.com"), "first.last+tag@example.com");
  });

  it("strips comma-injected extra recipients from the magic-link identifier", () => {
    assert.equal(
      normalizeIdentifier("Bob@example.com,attacker@evil.test"),
      "bob@example.com",
    );
  });

  it("does not choke on input with no @", () => {
    assert.equal(normalizeIdentifier("nonsense"), "nonsense");
  });
});
