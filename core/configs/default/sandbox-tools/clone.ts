// sandbox-tools/clone.ts — A SANDBOX SESSION'S WORKING FOLDER AS A CLONE OF THE MIND'S CONFIG REPO,
// for any kind of agent whose sessions each run in a sandbox of their own: ACP's
// (../acp-sandbox/runner.ts) and the Claude kind's (claude-sandbox/runner.ts in
// internal-packages/claude-code-bridge). The worker hands its start script what to clone
// (`cloneEnv`), and the start script has CLONE_SCRIPT in it, before it starts its host.
//
// This folder imports nothing of a kind: only the platform's types, and its own files. Copy it
// into a mind's config repo beside the kind's own folder.
import type { IterateContextApi } from "iterate/api";

/** The mind's config repo: what a new session's working folder is a clone of. */
export const CONFIG_REPO = "/repos/config";
/** How long a token for the repo's remote lives. A start script uses it within its half minute. */
const CLONE_TOKEN_SECONDS = 300;

/** WHAT THE START SCRIPT CLONES for a session that has no working folder yet: the config repo's
 *  git remote (the platform keeps a mind's repos in Cloudflare Artifacts), a token that reads that
 *  one repo for CLONE_TOKEN_SECONDS, and the folder. So an agent starts in the mind's own code,
 *  with its history, and not in an empty repo.
 *
 *  `box` is the session's sandbox and `into` its working folder there.
 *
 *  Nothing for a session whose folder is there (it started before, and its sandbox woke): no
 *  token is made.
 *
 *  A remote or a token that cannot be had THROWS, and so fails the start: the delivery asks
 *  again, and the session starts in a clone then. To start without one would leave the session in
 *  an empty repo for good, since a folder that is a repo is never cloned over. */
export async function cloneEnv(
  itx: Pick<IterateContextApi, "sandboxes" | "cfArtifacts">,
  { box, into }: { box: string; into: string },
): Promise<Record<string, string>> {
  const cloned = await itx.sandboxes
    .get(box)
    .files.stat(`${into}/.git`)
    .then(
      () => true,
      () => false,
    );
  if (cloned) return {};
  const { remote, token } = await repoAccess(itx).catch((error: unknown) => {
    throw new Error(
      `the mind's config repo could not be had for the session's clone: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  return {
    SANDBOX_CLONE: remote,
    SANDBOX_CLONE_TOKEN: token,
    SANDBOX_CLONE_INTO: into,
  };
}

/** The config repo's git remote, and a token that reads that one repo for CLONE_TOKEN_SECONDS:
 *  for one clone, or one fetch (./mind-tools.ts). */
export async function repoAccess(itx: Pick<IterateContextApi, "cfArtifacts">) {
  const repo = await itx.cfArtifacts.get(CONFIG_REPO);
  const [remote, token] = await Promise.all([
    repo.remote(),
    repo.createToken("read", CLONE_TOKEN_SECONDS),
  ]);
  return { remote, token: token.plaintext };
}

/** THE CLONE, a part of a kind's start script, before its host starts: `$SANDBOX_CLONE` into
 *  `$SANDBOX_CLONE_INTO`, unless that folder is a repo already. The token goes to git as one
 *  header of this one command, so it is not in the clone's config, and it is unset after, so the
 *  host and the agent it starts never have it. Cloned aside and renamed: a start that is cut off
 *  halfway leaves no folder that looks like a repo. A clone that fails stops the start and says
 *  what git said. */
export const CLONE_SCRIPT = String.raw`
if [ -n "$SANDBOX_CLONE" ] && [ ! -e "$SANDBOX_CLONE_INTO/.git" ]; then
  aside="$SANDBOX_CLONE_INTO.cloning"
  rm -rf "$aside"; mkdir -p "$(dirname "$aside")"
  auth=$(printf 'x:%s' "$SANDBOX_CLONE_TOKEN" | base64 | tr -d '\n')
  # git gives up on a remote that sends nothing for 15 s: a start script has half a minute in all
  if said=$(git -c "http.extraHeader=Authorization: Basic $auth" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=15 clone --quiet "$SANDBOX_CLONE" "$aside" 2>&1); then
    mv "$aside" "$SANDBOX_CLONE_INTO"
    echo "cloned the mind's config repo into $SANDBOX_CLONE_INTO"
  else
    echo "the mind's config repo was not cloned:"; printf '%s\n' "$said" | tail -n 3
    rm -rf "$aside"; exit 1
  fi
fi
unset SANDBOX_CLONE_TOKEN
`;
