// platform-append.ts — AN APPEND THAT IS THE PLATFORM'S OWN. The kernel takes `platform: true`
// from this Worker's own code alone: ./rpc.ts (the boundary's calls) and ./http.ts use it.
import { contextAt, type Caller } from "core-itx";
import type { StreamEvent, StreamEventInput } from "iterate/stream/processor";

// The cast: `invoke` answers `unknown`, and the built-in `append` answers the events it wrote.
export const appendAsPlatform = async (
  path: string,
  events: StreamEventInput[],
  signer?: Caller["signer"],
) =>
  (await contextAt(path).invoke(["itx", "builtins", ["append", ...events]], [], {
    principal: null,
    platform: true,
    signer,
  })) as StreamEvent[];
