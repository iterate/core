import { defineProcessorContract } from "iterate/stream/processor";
import { entityLifecycle } from "../mind/entity-lifecycle.ts";

export const WorkspaceContract = defineProcessorContract({
  ...entityLifecycle("workspace"),
  version: "2",
  description: "A workspace: its creation and deletion.",
});

export const WORKSPACES_ROOT_DESCRIPTION =
  "a private overlay over the repos: `workspaces.get(path).writeFile(f, text)` · `gitCommit({ message, scope })`";
