/**
 * Where to send someone after they sign in.
 *
 * `proxy.ts` bounces a signed-out request to `/signin?callbackUrl=<the full URL
 * they asked for>` — Auth.js builds that from `request.nextUrl.href`. The sign-
 * in actions used to ignore it and always land on /collections, which is fine
 * for someone who typed the address and wrong for the case that matters: a
 * friend opening a draft invite (`/drafts/join/<slug>`) has to come back to the
 * invite, or the link they were sent has done nothing.
 *
 * The value is attacker-controlled — anyone can link to
 * `/signin?callbackUrl=https://evil.example` — so only the PATH survives. The
 * origin is always thrown away, whatever it was, which is what makes this not
 * an open redirect: the worst a crafted link can do is choose which of this
 * app's own pages you land on. Dependency-free, so test/auth.test.ts loads it
 * under Node's type stripping.
 */

export const CALLBACK_PARAM = "callbackUrl";

export function safeCallbackPath(value: unknown): string | null {
  if (typeof value !== "string" || value === "" || value.length > 2048) return null;

  let url: URL;
  try {
    // The base only resolves a bare path; its host is never used.
    url = new URL(value, "http://callback.invalid");
  } catch {
    return null;
  }

  const path = `${url.pathname}${url.search}`;
  // `new URL("http://x//evil.example").pathname` is "//evil.example", which a
  // browser reads as a protocol-relative link to another host. The URL parser
  // has already turned `\` into `/`, so this one test covers `/\evil` too.
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  // Landing back on the sign-in form after signing in is a loop, and nobody
  // is "returned" to a JSON endpoint.
  if (/^\/(signin|signup|api)(\/|\?|$)/.test(path)) return null;
  return path;
}
