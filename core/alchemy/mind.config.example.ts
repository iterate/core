// Copy to mind.config.local.ts (git ignores it) and fill in the real values; the same config as
// JSON works too (ITERATE_MIND_CONFIG=<file>.json). src/config.ts says what each field does.
import type { MindConfig } from "./src/config.ts";

export default {
  name: "example",
  accountId: "00000000000000000000000000000000",
  domain: "example.com",
  auth: {
    login: {
      // A mailed code needs `mail: true`. Log in with iterate is
      // `iterate: { issuer: "https://os.iterate.com" }`, beside it or instead.
      methods: { email: {} },
      allow: [{ email: "person@example.org" }],
    },
    trustedClients: ["https://agents.example.org"],
  },
  mail: true,
} satisfies MindConfig;
