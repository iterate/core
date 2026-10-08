// src/secret/processor.ts — THE SECRET PROCESSOR: the pure reduce of a secret's facts into its
// current material — the sealed cell of the latest write (`secret/set`), or of the reseal or the
// minting refresh that followed it and named it (`basedOn`); one naming an older write lost to a
// write that landed meanwhile and changes nothing. No saga and no effect live here — the write is a
// verb (`itx.secrets.set`, context/built-ins.ts) and the facet (durable-object.ts) opens the cell;
// the kernel's `ProcessorEngine` drives this reduce inside that facet and answers it as
// `snapshot()`. Imports only the pure kernel, so a unit test constructs it with `new` and reduces
// rows (processor.test.ts, in node).
import { type ConsumedEvent, type ReduceArgs, StreamProcessor } from "iterate/stream/processor";
import { SecretContract, type SecretState } from "./contract.ts";

export class SecretProcessor extends StreamProcessor<
  SecretState,
  ConsumedEvent<typeof SecretContract>
> {
  readonly contract = SecretContract;

  override reduce({
    state,
    event,
  }: ReduceArgs<SecretState, ConsumedEvent<typeof SecretContract>>): SecretState | undefined {
    switch (event.type) {
      case "events.iterate.com/secret/set":
        // Every write is the latest; a set after a deletion brings the secret back.
        return {
          ...state,
          material: {
            offset: event.offset,
            setAt: event.offset,
            setNonce: event.payload.sealed?.nonce,
            sealed: event.payload.sealed,
          },
          deletion: null,
          borrowed: null,
        };
      case "events.iterate.com/secret/resealed":
      case "events.iterate.com/secret/refreshed": {
        // The cell of the write it names, sealed again or refreshed: current only while that write
        // still is — a write that landed meanwhile is the material, and this is a harmless fact.
        const { sealed, basedOn } = event.payload;
        if (!sealed || basedOn === undefined || state.material?.offset !== basedOn)
          return undefined;
        return { ...state, material: { ...state.material, offset: event.offset, sealed } };
      }
      case "events.iterate.com/secret/borrowed":
        return {
          material: { offset: event.offset, setAt: event.offset },
          deletion: null,
          borrowed: { lendId: event.payload.lendId },
        };
      case "events.iterate.com/secret/lend-revoked":
        // on the lender's path a lend is not the material; on the borrower's it was all there was
        if (state.borrowed?.lendId !== event.payload.lendId) return undefined;
        return { material: null, deletion: { offset: event.offset }, borrowed: null };
      case "events.iterate.com/secret/deleted":
        // Dies once: a certificate after the certificate is a harmless fact.
        return !state.material && state.deletion
          ? undefined
          : { material: null, deletion: { offset: event.offset }, borrowed: null };
      default:
        return undefined;
    }
  }
}
