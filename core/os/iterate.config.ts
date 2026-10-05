// iterate.config.ts — THE ITERATE CONFIG A DEPLOY USES: `ITERATE` (one JSON object) and
// `ITERATE__<PATH>` (one field each) from the environment, which a secrets manager, CI, or
// .secrets beside this file fills (`pnpm run deploy` loads .secrets). src/iterate-config.ts
// documents every field and its default.
//
// To set values in code, write iterate.config.local.ts beside this file (gitignored), which
// `pnpm run deploy` then uses instead (SELF-HOSTING.md, "The config"):
//
//   import type { IterateConfigInput } from "./src/iterate-config.ts";
//   import base from "./iterate.config.ts";
//   export default { ...base, cloudflare: { accountId: "…", resourcePrefix: "my-iterate" } } satisfies IterateConfigInput;
import { iterateConfigFromEnv } from "./src/iterate-config.ts";

export default iterateConfigFromEnv(process.env);
