// The mind as a Worker of the stack: each call is a call on the `MIND` service binding.
import type { Env } from "../env.ts";
import type { MindTransport } from "../http.ts";

export const boundMind = (env: Env): MindTransport => ({
  fetch: (request) => env.MIND.fetch(request),
  append: (path, events, fromAuth) => env.MIND.append(path, events, fromAuth),
  runAct: (held) => env.MIND.runAct(held),
  receiveEmail: (mail) => env.MIND.receiveEmail(mail),
});
