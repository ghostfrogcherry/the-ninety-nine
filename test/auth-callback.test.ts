/**
 * Where sign-in sends you afterwards (lib/auth/callback.ts).
 *
 *   npm test
 *
 * The case that matters is a draft invite: a signed-out friend opens
 * /drafts/join/<slug>, the proxy sends them to /signin?callbackUrl=<that URL>,
 * and after signing in — or signing up — they must land back on the invite.
 * The case that must never happen is that URL naming another site.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type * as CallbackModule from "../lib/auth/callback";

const callbackSpecifier = "../lib/auth/callback.ts";
const { safeCallbackPath } = (await import(callbackSpecifier)) as typeof CallbackModule;

describe("safeCallbackPath", () => {
  it("keeps the path of the absolute URL the proxy builds", () => {
    assert.equal(
      safeCallbackPath("http://localhost:3010/drafts/join/0123456789abcdefghjk"),
      "/drafts/join/0123456789abcdefghjk",
    );
    assert.equal(safeCallbackPath("https://mtg.example/decks/7?q=sol"), "/decks/7?q=sol");
  });

  it("accepts a bare path", () => {
    assert.equal(safeCallbackPath("/drafts/12"), "/drafts/12");
  });

  it("never keeps another origin — only its path survives", () => {
    assert.equal(safeCallbackPath("https://evil.example/"), "/");
    assert.equal(safeCallbackPath("https://evil.example/drafts/1"), "/drafts/1");
  });

  it("refuses protocol-relative paths in every spelling", () => {
    for (const bad of ["//evil.example", "http://x//evil.example/path", "/\\evil.example", "\\\\evil.example"]) {
      const out = safeCallbackPath(bad);
      assert.ok(out === null || (!out.startsWith("//") && out.startsWith("/")), `${bad} -> ${out}`);
    }
    assert.equal(safeCallbackPath("http://x//evil.example"), null);
  });

  it("refuses schemes that are not a place", () => {
    assert.equal(safeCallbackPath("javascript:alert(1)"), null);
    assert.equal(safeCallbackPath("data:text/html,hi"), null);
  });

  it("does not send you back to sign-in or into the API", () => {
    for (const loop of ["/signin", "/signin?error=x", "/signup", "/api/auth/signout", "http://h/signin"]) {
      assert.equal(safeCallbackPath(loop), null, loop);
    }
    assert.equal(safeCallbackPath("/signing-bonus"), "/signing-bonus");
  });

  it("ignores anything that is not a sensible string", () => {
    for (const bad of [null, undefined, "", 42, {}, ["/drafts"], "x".repeat(3000)]) {
      assert.equal(safeCallbackPath(bad), null);
    }
  });
});
