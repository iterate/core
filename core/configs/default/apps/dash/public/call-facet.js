// call-facet.js — THE CALL'S FACET SPEC for the Dash's "Start a call": the same object as
// `CALL_FACET` in ../../../call.ts, written here because a browser module cannot import call.ts
// (it imports iterate/sdk). A test holds the two equal (core/lib config-default-dash.test.ts).
export const CALL_FACET = {
  className: "CallDurableObject",
  mainModule: "call.ts",
  source: ["itx", ["cd", "/"], "config"],
  consumes: [
    "share/link-made",
    "share/link-ended",
    "share/guest-joined",
    "events.iterate.com/itx/subscription-configured",
    "call/due",
  ],
};
