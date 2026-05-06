/**
 * Tiny KV-backed rate limiter. Not perfectly atomic (KV is eventually
 * consistent), but more than sufficient for blocking abusive bursts of
 * expensive operations (LLM calls). Each bucket tracks per-IP counts in a
 * fixed-window window-of-N-seconds keyspace.
 *
 * Falls open on KV errors so an outage doesn't lock everyone out.
 */

export interface RateLimitOpts {
  kv: KVNamespace;
  bucket: string;       // logical name, e.g. "gen" or "ident"
  ip: string;
  limit: number;        // max events per window
  windowSec: number;    // window length in seconds
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; retryAfter: number; limit: number };

export async function rateLimit(o: RateLimitOpts): Promise<RateLimitResult> {
  if (!o.ip || o.ip === "unknown") {
    // Without a stable IP we can't enforce; fall through and let the
    // global daily cap protect us.
    return { ok: true };
  }
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / o.windowSec) * o.windowSec;
  const reset = window + o.windowSec;
  const key = `__rl:${o.bucket}:${window}:${o.ip}`;

  try {
    const curRaw = await o.kv.get(key);
    const cur = curRaw ? parseInt(curRaw, 10) || 0 : 0;
    if (cur >= o.limit) {
      return {
        ok: false,
        retryAfter: Math.max(1, reset - now),
        limit: o.limit,
      };
    }
    // Best-effort increment. A simultaneous burst could undercount; that's
    // fine, the global daily cap is the hard backstop.
    await o.kv.put(key, String(cur + 1), {
      expirationTtl: Math.max(60, o.windowSec * 2),
    });
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

/** Best-effort client IP. Cloudflare always populates `cf-connecting-ip`. */
export function clientIp(c: {
  req: { header: (n: string) => string | undefined };
}): string {
  return (
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}
