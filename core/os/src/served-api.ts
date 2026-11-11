// served-api.ts — THE PUBLISHED API AS THIS PLATFORM SERVES IT: iterate/api less what only the
// project stack serves (a repo's bytes, `secrets.describe`). The conformance checks
// (iterate-context.ts `publishedContextApiOf`, session.ts `IterateRpcTarget`) read these.
import type {
  EntityCollectionApi,
  IterateContextApi,
  IterateSessionApi,
  RepoHandle,
  SessionCredentials,
} from "iterate/api";

export type ServedContextApi = {
  [K in keyof IterateContextApi]: K extends "repos"
    ? EntityCollectionApi<Omit<RepoHandle, "readBytes">>
    : K extends "secrets"
      ? Omit<IterateContextApi["secrets"], "describe">
      : Served<IterateContextApi[K]>;
};

/** `T` with every `IterateContextApi` it hands out read as a `ServedContextApi`. */
type Served<T> = T extends IterateContextApi
  ? ServedContextApi
  : T extends (...args: infer A) => infer R
    ? { method(...args: A): Served<R> }["method"] // a method, so its parameters stay bivariant
    : T extends Promise<infer U>
      ? Promise<Served<U>>
      : T extends object
        ? { [K in keyof T]: Served<T[K]> }
        : T;

export type ServedSessionApi = Served<IterateSessionApi>;

export interface ServedApi {
  authenticate(credentials: SessionCredentials): Promise<ServedSessionApi>;
}
