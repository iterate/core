// config.ts — THE BOUNDARY'S SETTINGS: the config that every Worker of the mind gets
// (iterate/mind-config), and nothing of its own. The boundary holds no key.
import { mindConfigOf } from "iterate/mind-config";

// A Worker's `env` is one object for the life of its isolate, so it keys the memo: the config is
// parsed at an isolate's first request, and a malformed one throws there, naming its field.
const parsed = new WeakMap<object, ReturnType<typeof mindConfigOf<{}>>>();

export function boundaryConfigOf(env: object) {
  const config = parsed.get(env) || mindConfigOf(env, {});
  parsed.set(env, config);
  return config;
}
