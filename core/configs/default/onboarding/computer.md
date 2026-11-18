# Your devices lend the mind what they have

The owner should come away with: each device they own can lend the mind what it has, only while they let it, and they stop it with one press or Ctrl-C. A browser lends its tabs, a computer its commands and files, and any computer a local server, which then answers at a host of the mind and which the mind can call.

## Ready today

**Their Chrome, through iterate's extension** (`packages/browser-extension/README.md` in
https://github.com/iterate/packages). It lends one Chrome, and only the tabs in one tab group
named exactly `<domain>`: the mind lists them, opens a page in the group, and sends Chrome
DevTools commands to a tab (read, click, type, screenshot). A tab in use shows a frame and a
label "<domain> is using this tab" with a Stop button. Not in the Chrome Web Store. The owner:

1. Download the ZIP from https://chrome.iterate.com/; unzip it. Chrome 123+.
2. Open `chrome://extensions`, turn on Developer mode, press "Load unpacked", pick that folder.
3. Pin it from the toolbar's extensions menu, and click it to open its panel.
4. Enter `<domain>`, press "Sign in with Iterate", allow the host; the mind's sign-in opens.
5. Press "Share this browser". "Turn sharing off", "Sign out" or a restart of Chrome ends it.

**Their computer, from a terminal**, with Node.js on it:

```sh
npx iterate@latest use-my-computer --mind <domain>
```

The first time, it signs them in to the mind in their browser. It asks what agents should call
the computer (the first word of its name and `Computer`, such as `anaComputer`), and lends it
until Ctrl-C: run commands (`exec`), read and write files (`files`), and on a Mac a dialog, a
notification and Swift (`mac`). It acts with the owner's own permissions.

**A local server at a host of the mind**, from a terminal, with Node.js on it. For an owner who
builds software, this is the moment: the dev server on their laptop is at their domain.

```sh
npx iterate@latest tunnel 5173 --name blog --mind <domain>
```

`https://blog.<domain>/` then serves `http://localhost:5173` until Ctrl-C, WebSockets included,
so a dev server's live reload works there. Only the mind's members get in: a visitor signs in
with the mind's sign-in first. `--public` lets anyone in; without `--name` the name is random.
Ctrl-C takes the host down at once. The mind cannot start it: give the owner the line with their
domain and a name filled in. Once it runs, the mind can call the server as `itx.tunnels.<name>`:
check that it answers before you say it works.

## Not ready

- None of these is tried in onboarding with an owner. The extension's download address and
  version may move: check the README before you give its steps.
- Not built: a device that the mind's requests go out through, and a picture shown on a phone's
  or a TV's screen. Do not offer them. A Mac lent as a computer can show a dialog or a
  notification (`mac`).

## How

What is lent now, from your script (lends sit on the mind's root):

```ts
return (await itx.cd("/").rewriteRules.list())
  .filter((rule) => rule.lentBy)
  .map(({ match, description }) => ({ match, description }));
```

A Chrome is `itx.chrome.<person>.<browser>`; a computer is `itx.<name>`; a local server is
`itx.tunnels.<name>`. For example:

```ts
const chrome = itx.cd("/").chrome.ana.mac3f9a; // the name you found
const tabs = await chrome.tabs();
const answer = await itx.cd("/").anaComputer.exec(["ls", "-la"]);
const page = await itx.cd("/").tunnels.blog.fetch(new Request("https://blog.<domain>/"));
return { tabs, out: new TextDecoder().decode(answer.stdout), page: page.status };
```

`chrome.openPage({ url })` opens a tab in the group; `chrome.cdp(tabId, method, params)` sends
one command. Ask before anything that deletes, buys or sends.

## Say

- "If you lend me your browser, I can work on sites where you are signed in: only in the tabs you
  put in one group, and you stop me with one press."
- "Is something running on your laptop, a dev server or a tool? One command puts it at
  blog.<domain> for you and your people, and Ctrl-C ends it."
