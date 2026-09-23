/**
 * Liveness check behind `GET /api/health` and the app's compose healthcheck.
 *
 * `restart: unless-stopped` only notices a container whose process has exited.
 * The failures that actually leave this app useless do not exit: a pool whose
 * ten connections are all stuck, an event loop pinned by one enormous import,
 * a database that went away underneath a server that is still listening. Each
 * of those answers TCP and serves nothing. So the check has to do what a page
 * does — take a connection from the app's own pool and run a query — and has to
 * give up on its own, quickly, rather than wait as long as the thing it is
 * checking.
 *
 * Pure and Next-free, typed against a structural `Queryable` rather than `pg`,
 * so `test/health.test.ts` can drive the timeout and the failure paths with a
 * fake and no Postgres. Same trick as `lib/deck/index.ts`.
 */

export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(text: string, values?: any[]): Promise<unknown>;
}

/**
 * How long the database gets to answer `SELECT 1`.
 *
 * Well under the compose healthcheck's own 5s timeout, so a slow database comes
 * back as a clean 503 the healthcheck can report, instead of the probe being
 * killed mid-request and the cause being indistinguishable from a dead server.
 * And far above anything a healthy local Postgres needs — a query that trivial
 * taking two seconds is itself the symptom.
 */
export const HEALTH_TIMEOUT_MS = 2_000;

/**
 * `reason` is for the server log only. The route never puts it in a response:
 * the endpoint is unauthenticated, and "error" vs "timeout" — let alone the
 * driver's message, which can name the host, the database and the role — is
 * reconnaissance for anyone who can reach the port.
 */
export type HealthResult = { ok: true } | { ok: false; reason: "timeout" | "error" };

export async function checkDatabase(
  db: Queryable,
  timeoutMs: number = HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<HealthResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), timeoutMs);
  });

  // `.then(() => db.query(...))` rather than calling it directly, so a driver
  // that throws synchronously becomes a failed check instead of escaping as a
  // 500 with a stack trace in it. The error itself is dropped right here, so
  // nothing downstream can be tempted to echo it. And a query that finally
  // fails AFTER the timeout has answered lands in a handler rather than as an
  // unhandled rejection, which would take down the process being checked.
  const probed = Promise.resolve()
    .then(() => db.query("SELECT 1"))
    .then(
      (): HealthResult => ({ ok: true }),
      (): HealthResult => ({ ok: false, reason: "error" }),
    );

  try {
    return await Promise.race([probed, timedOut]);
  } finally {
    // A timer left running holds a test process open for its full length, and
    // in the server it is one more pending callback per check for nothing.
    clearTimeout(timer);
  }
}

/** 200 or 503, nothing in between: a healthcheck reads the status and nothing else. */
export function healthStatus(result: HealthResult): 200 | 503 {
  return result.ok ? 200 : 503;
}
