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
  For example, the agents' settings are in `agents.ts` and the onboarding agent's text is in
  `onboarding.md`.
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
- **A case that an older template lacks.** The `events.iterate.com/cloud/installation-handed-over`
  case gives the onboarding agent what the person told iterate Cloud's installation agent
  (`cloud-handover.ts`). A mind made from an older template has no case, and the event stays on
  `/integrations/cloud` unread.
