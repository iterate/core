# When the template moves on

What a deploy of newer platform code does to this repo, and how to follow the template again
(`core/mind-worker/src/mind/template-update.ts` in https://github.com/iterate/core).

A deploy of newer platform code compares this repo with the template it brings, and commits what
is newer (`template: core/configs/<name>`). It writes a file only when the file is still what the
platform wrote there; a file you changed or deleted is yours, and stays.

- **An app follows whole or not at all.** If one file under `apps/<name>/` is yours, the app
  stays at the version it has. The root's event `mind/template-applied` names it (`appsLeftOld`). A
  file of the platform's that imports a file of that app stays too (`heldBack`): `worker.ts`, when
  the newer one imports the newer app.
- **A file the newer template no longer has stays, and nothing reads it.** When it is yours, the
  event names it (`leftBehind`): carry what you changed there into the file that took its place.
  For example, the agents' settings are in `agents.ts`, and the onboarding agent's guides are in
  the repo `/repos/onboarding`, not in this one.
- **Your `package.json` gets the packages that newer files import**, each at the template's
  version, when it does not list them (`packagesAdded` in the same event). Nothing else of the
  file changes, and a version you set is never changed: a package you list at an older version
  than the template's is named in the event (`packagesOlder`), for you to raise.
- **To follow the template again, commit the template's file over yours** (the files of
  `core/configs/default` in https://github.com/iterate/core). A
  file that is the template's bytes, or an earlier version the platform wrote, is the
  platform's again. An app that the last update left at its version then follows at the mind's
  next restart. Where no app was left, a file you set back waits for the next deploy that brings
  a different template: the same template is not compared twice.
- **An app with one file that is yours on purpose** (an `app.ts` of your own, a file you took
  out) stays at its version whole, at every deploy: its page does not follow. To bring the page
  up, commit the other files of the app yourself, each with the bytes of the template at the
  version the mind runs (`core/configs/default/apps/<name>/` in https://github.com/iterate/core).
  The page's files go together: `index.html` names the modules that `public/` imports.
- **BEFORE A DEPLOY, IF `agents.ts` IS YOURS: take the template's.** Until 24 November 2026 the
  platform had an agent of its own, and `agents.ts` imported its class
  (`import { AgentDurableObject, AI_GATEWAY } from "iterate/agents"`). The platform has no such
  agent now: the agent is this repo's `agent/` folder, and `iterate/agents` exports neither name.
  A file that imports a name which is gone does not load, and then NOTHING of this repo runs: no
  page, no agent. A deploy leaves your own `agents.ts` as it is. So commit the template's
  `agents.ts` first (three lines: it names the agent that `itx.agents.create` starts), with the
  template's `agent/`, `agent-start.ts`, `agent-prompt.ts`, `agent-ui.ts` and
  `agent-kinds/agent.ts` if this repo has none, and then deploy. What you had set on the class
  has a place of its own: what pays is `WHAT_PAYS` in `agent-start.ts`, and the files an agent
  is told are in `agent-prompt.ts` ([agent-kinds.md](agent-kinds.md)). To look first:
  `(await itx.repos.get("/repos/config").readFile("agents.ts")).includes("AgentDurableObject")`.
- **A case that an older template lacks.** The `events.iterate.com/cloud/installation-handed-over`
  case gives the onboarding agent what the person told iterate Cloud's installation agent
  (`cloud-handover.ts`). A mind made from an older template has no case, and the event stays on
  `/integrations/cloud` unread.
