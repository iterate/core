import type { Caller, ItxHostRootContext } from "core-itx";

// The platform's own hop: the caller without its loaded `app`, from the context it originated at.
export function hopCaller(context: Pick<ItxHostRootContext, "caller" | "path">): Caller {
  const { app: _loadedCode, ...caller } = context.caller();
  return { ...caller, path: caller.path || context.path };
}
