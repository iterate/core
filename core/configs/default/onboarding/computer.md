# Lending a browser and a computer

The owner should come away with: the mind can use their browser and their computer, only while they lend it, and they stop it with one press.

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

## Not ready

- Neither is tried in onboarding. The download address and the version may move: check the
  README before you give the steps.

## How

What is lent now, from your script (lends sit on the mind's root):

```ts
return (await itx.cd("/").rewriteRules.list())
  .filter((rule) => rule.lentBy)
  .map(({ match, description }) => ({ match, description }));
```

A Chrome is `itx.chrome.<person>.<browser>`; a computer is `itx.<name>`. For example:

```ts
const chrome = itx.cd("/").chrome.ana.mac3f9a; // the name you found
const tabs = await chrome.tabs();
const answer = await itx.cd("/").anaComputer.exec(["ls", "-la"]);
return { tabs, out: new TextDecoder().decode(answer.stdout) };
```

`chrome.openPage({ url })` opens a tab in the group; `chrome.cdp(tabId, method, params)` sends
one command. Ask before anything that deletes, buys or sends.

## Say

- "If you lend me your browser, I can work on sites where you are signed in: only in the tabs you
  put in one group, and you stop me with one press."
