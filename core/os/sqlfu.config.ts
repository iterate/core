// sqlfu (https://github.com/mmkal/sqlfu) authors the control plane's D1 (src/control-plane/db/,
// README.md "The control plane's database"). Authoring only, so no `db`, as sqlfu's guide has it
// (packages/sqlfu/docs/guides/cloudflare-d1.md: "For authoring only, omit `db`"): `sqlfu check`
// and `migrate` run on its scratch node:sqlite `.sqlfu/app.db`. The local D1 is migrated by cf
// (`pnpm db:migrate`, its `d1_migrations` table); a deployment's D1 by Alchemy (alchemy/stack.ts,
// its `__alchemy_migrations` table).
import { defineConfig } from "sqlfu";

export default defineConfig({
  definitions: "./src/control-plane/db/definitions.sql",
  migrations: { path: "./src/control-plane/db/migrations", preset: "d1" },
  queries: "./src/control-plane/db/queries",
});
