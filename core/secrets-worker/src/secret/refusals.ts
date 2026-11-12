// THE THREE REFUSALS OF A SECRET'S USE, IN WORDS THAT SAY WHAT TO DO. What a secret may be used
// for is fixed when it is made (secrets.ts `secretUseOf`): no operation, a header alone and no lend
// unless its maker names them. So each refusal names the option that was not given, what the
// secret may do now, and the call that sets it again with the option. A set replaces the whole
// secret, so that call carries the material and what the secret had before.
import type { SecretOperation } from "iterate/api";

const list = (values: readonly string[]) => (values.length ? values.join(", ") : "none");
const quoted = (values: readonly string[]) =>
  values.map((value) => JSON.stringify(value)).join(", ");

/** `verb` asked of a secret that was not made with it. */
export function operationRefusal(
  verb: SecretOperation,
  path: string,
  operations: readonly SecretOperation[],
): string {
  return `${verb}: ${path} was not made to answer it: its operations are ${list(operations)}. Name the operation when the secret is made: itx.secrets.set(${JSON.stringify(path)}, material, { urls, operations: [${quoted([...operations, verb])}] }). collectFromUser and beginOAuth take the same option, which the person who gives the secret sees. A set replaces the whole secret, so give its material and its other options again.`;
}

/** A placeholder of a secret in a request's URL, when the secret is placed in headers alone. */
export function placementRefusal(path: string): string {
  return `itx.fetch: the secret ${path} is placed in headers alone, so it is not put into a request's URL. Name the placement when the secret is made: itx.secrets.set(${JSON.stringify(path)}, material, { urls, placement: "url" }). collectFromUser and beginOAuth take the same option. A set replaces the whole secret, so give its material and its other options again.`;
}

/** The refresh of `borrower` asked for the material of a secret that does not lend to it. */
export function lendRefusal(path: string, borrower: string, lendTo: readonly string[]): string {
  return `secrets: ${path} does not lend to ${borrower}: it lends to ${list(lendTo)}. Name the borrower when the secret is made: itx.secrets.set(${JSON.stringify(path)}, material, { urls, lendTo: [${quoted([...lendTo, borrower])}] }). collectFromUser and beginOAuth take the same option. A set replaces the whole secret, so give its material and its other options again.`;
}
