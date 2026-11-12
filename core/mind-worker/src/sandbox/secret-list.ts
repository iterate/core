// A sandbox's own list of the secrets its requests may name (`start({ secrets })`). With no list a
// sandbox may name any secret pinned to where it sends, as before.
import { secretPathsReferenced } from "iterate/secret-placeholder";

/** A refusal for a request that names a secret outside `list`, or null. An agent in the sandbox
 *  reads the text. */
export function secretListRefusal(request: Request, list: readonly string[] | undefined) {
  if (!list) return null;
  const outside = secretPathsReferenced(request).filter((path) => !list.includes(path));
  if (outside.length === 0) return null;
  const allowed = list.length ? list.join(", ") : "no secret";
  return new Response(
    `sandbox egress: this sandbox's secret list does not name ${outside.join(", ")}; its requests may name ${allowed}\n`,
    { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } },
  );
}

/** The list a start names for a sandbox that already runs: narrower than the one its egress holds
 *  (or the first one) applies at once; wider is refused, since processes inside are running already. */
export function narrowedSecretList(current: readonly string[] | undefined, given: string[]) {
  const wider = current ? given.filter((path) => !current.includes(path)) : [];
  if (wider.length)
    throw new Error(
      `sandbox: the list of a running sandbox only narrows, and its list (${current!.join(", ") || "no secret"}) does not name ${wider.join(", ")}: stop it with .container.destroy(), then start it with the wider list`,
    );
  return given;
}
