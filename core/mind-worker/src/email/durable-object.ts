import { StreamProcessorDurableObject, type ItxEntrypointService } from "iterate/sdk";
import type { EmailState } from "iterate/email";
import type { ItxEntrypointScope } from "core-itx";
import { EmailProcessor } from "./processor.ts";

export class EmailFacet extends StreamProcessorDurableObject<
  EmailState,
  { ITX?: ItxEntrypointService },
  ItxEntrypointScope
> {
  processor = new EmailProcessor();
}
