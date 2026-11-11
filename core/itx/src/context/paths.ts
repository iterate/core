import { codedError, resolveContextPath } from "iterate/lib";

/** Root first: `/a/b/c` → `/`, `/a`, `/a/b`; `/` has none. */
export function ancestorPathsOf(path: string): string[] {
  const segments = resolveContextPath("/", path).split("/").filter(Boolean);
  return segments.map((_, index) => `/${segments.slice(0, index).join("/")}`);
}

// A context's Durable Object name IS its canonical path. Each hosting Worker binds its own
// namespace of the class, so a name says nothing about a mind: the namespace is the isolation.
export type DurableObjectAddress = { path: string; name: string };

export const DurableObjectNameCodec = {
  /** Canonical, so `/a`, `/a/`, `/a/./` and `a` are one name: no entry point can mint a twin DO. */
  stringify(path: string): string {
    return resolveContextPath("/", path);
  },
  address(path: string): DurableObjectAddress {
    const canonical = resolveContextPath("/", path);
    return { path: canonical, name: canonical };
  },
  /** Only a canonical path is a name: an object reached as `a` or `/a/` would be a twin of `/a`. */
  parse(name: string): DurableObjectAddress {
    const address = DurableObjectNameCodec.address(name);
    if (address.name !== name)
      throw codedError(
        "INVALID_CONTEXT",
        `invalid context name ${JSON.stringify(name)}: a context's name is its canonical path, ${JSON.stringify(address.name)}`,
      );
    return address;
  },
};
