// config.ts — THE TELEMETRY WORKER'S SETTINGS: the config that every Worker of the mind gets
// (iterate/mind-config), and this Worker's own fields. The stack writes the fields into the
// variable `ITERATE`, and each secret as a secret variable of its own, `ITERATE__<NAME>`.
import { redacted } from "iterate/app-config";
import { mindConfigOf } from "iterate/mind-config";
import { z } from "zod";

const own = {
  /** The Cloudflare account of the stack: both SQL APIs are addressed by it. */
  accountId: z.string().min(1),
  /** The R2 bucket whose data catalog holds the tables `events`, `logs` and `spans`. */
  telemetryBucketName: z.string().min(1),
  /** The Analytics Engine dataset that a query reads as `metrics`. */
  metricsDatasetName: z.string().min(1),
  /** The Workers whose logs and spans a query reads whole: the mind's own. Of the stack's other
   *  Workers a query reads no log line, and their spans without a request's detail. */
  workerNamesThatQueriesReadWhole: z.array(z.string().min(1)).min(1),
  /** What a row of `events` names as its writer, in the column `worker`: the mind Worker's name,
   *  or `external-mind` when the mind runs outside the stack and no Worker writes its events. */
  eventsWriterName: z.string().min(1),
  /** What Cloudflare's OpenTelemetry export proves itself with. Set by the secret variable
   *  `ITERATE__OTLP_SECRET`. */
  otlpSecret: redacted(z.string().min(1)),
  /** The API token that reads `events`, `logs` and `spans` (R2 SQL), set by the secret variable
   *  `ITERATE__CATALOG_TOKEN`. */
  catalogToken: redacted(z.string().min(1)),
  /** The API token that reads `metrics` (Account Analytics Read), set by the secret variable
   *  `ITERATE__ANALYTICS_TOKEN`. */
  analyticsToken: redacted(z.string().min(1)),
};

// A Worker's `env` is one object for the life of its isolate, so it keys the memo: the config is
// parsed at an isolate's first use of it, and a malformed one throws there, naming its field.
const parsed = new WeakMap<object, ReturnType<typeof mindConfigOf<typeof own>>>();

export function telemetryWorkerConfigOf(env: object) {
  const config = parsed.get(env) || mindConfigOf(env, own);
  parsed.set(env, config);
  return config;
}
