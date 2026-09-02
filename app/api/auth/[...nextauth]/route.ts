import { handlers } from "@/auth";

/**
 * Auth.js v5 route handler.
 *
 * The whole file. v5's `NextAuth()` returns `{ handlers }` containing GET and
 * POST already bound to the config — there is no `NextAuth(req, res, options)`
 * call to make here as there was in v4.
 *
 * `pg` and `bcryptjs` mean this must run on Node, not Edge. Next 16 defaults
 * route handlers to the Node runtime, so there is no `export const runtime`
 * line; adding `runtime = "edge"` here would break credential sign-in.
 */
export const { GET, POST } = handlers;
