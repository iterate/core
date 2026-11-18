// config.ts — THE MIND WORKER'S SETTINGS: the config that every Worker of the mind gets
// (iterate/mind-config), and this Worker's own key.
import { redacted } from "iterate/app-config";
import { mindConfigOf } from "iterate/mind-config";
import { z } from "zod";

const own = {
  /** The key the mind signs with: its file URLs, its webhooks' addresses, and who a run is for.
   *  Set by the secret variable `ITERATE__SIGNING_KEY`. Read it with `.exposeSecret()` only where
   *  it signs or verifies. */
  signingKey: redacted(z.string().min(1)),
};

/** The Worker's config, which `mindConfigOf` parses once for each `env` object. */
export const mindWorkerConfigOf = (env: object) => mindConfigOf(env, own);
