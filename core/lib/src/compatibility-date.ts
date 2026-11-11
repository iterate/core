/** The workerd compatibility date every Iterate Worker runs on: each deployed Worker's config
 *  (core/alchemy/src/stack.ts, core/home-lab, scripts/lib/wrangler-config.ts and start-app.ts,
 *  packages/spa's deploy) and each Worker a mind loads at runtime
 *  (core/mind-worker/src/context/worker-loader.ts,
 *  core/secrets-worker/src/secret/exchange-jail.ts). Moving it changes all of them at once: every
 *  compatibility flag whose enable date it passes (workerd's
 *  src/workerd/io/compatibility-date.capnp) turns on. */
export const COMPATIBILITY_DATE = "2026-11-04";
