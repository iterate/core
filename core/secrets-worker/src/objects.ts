// objects.ts — THE VAULT'S DURABLE OBJECTS, each reached by its name: one object for each secret,
// named by the secret's path, and the one gate for acts. ./http.ts and ./rpc.ts both reach them.
import { assertSecretPath } from "iterate/secret-placeholder";
import { GATE } from "./acts-gate.ts";
import type { Env } from "./env.ts";

export const secretObject = (env: Env, path: string) =>
  env.SECRET.getByName(assertSecretPath(path));

export const actsGate = (env: Env) => env.ACTS.getByName(GATE);
