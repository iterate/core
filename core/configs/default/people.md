# People who are not members

How a page serves people who are not members (the guards, the ways to sign in, the sign-in page),
a worked example, and the guestbook app: `this.auth` in `worker.ts` and `apps/guestbook/`.

Signing in says who someone is. Being a member is a separate list: a member reaches the whole
mind (its API, its MCP server, every context), and anyone else reaches only what `fetch` serves
them. So a page can serve people who are not members, an app's end users.

When a member is removed, or one of their grants ends, their next request is refused. A session
that is already open, such as a WebSocket to the mind's API or a live page, stays open until its
credential ends: within an hour, or within 24 hours for a sign-in on a host of the mind and a
let-in through `/provide`. The keys that a removed member allowed for services stay live until a
member removes them on `https://iterate.<domain>/keys`.

On every host of the mind, the platform holds the browser session. `fetch` gets each request
stamped: `this.auth.person(request)` is `{ userId, email, method }` for anyone signed in, and a
member is stamped as a principal too. Three guards, each `null` when the request may go on, else
the answer to return:

- `this.auth.requirePerson(request)`: anyone signed in. Signed out, a page load signs them in and
  comes back; a fetch gets a `401`.
- `this.auth.require(request)`: a member. Someone signed in who is no member gets a refusal page
  (a fetch gets a `403`).
- `this.auth.person(request)`: who they are, or `null`. Key what you keep for a person by
  `userId`, which never changes; an email can.

An app chooses the ways to sign in it takes, of those the mind's stack offers (`"passkey"`,
`"email"`, `"google"`, `"cloudflare"`), with `{ methods }` on `requirePerson` and `person`, in
the order its sign-in page shows them. A person who signed in another way is nobody to that guard:
a page load signs them in again on this host, and the sign-in page shows the app's ways alone.
Without `methods`, every way counts but Cloudflare's, which counts only where an app names it.
Check the bearer of an app's own MCP server the same way: `person(request, { methods })`, and add
`acr_values="cloudflare"` to its `WWW-Authenticate`.

```ts
const refused = this.auth.requirePerson(request, { methods: ["cloudflare"] });
if (refused) return refused;
const person = this.auth.person(request, { methods: ["cloudflare"] })!; // method: "cloudflare"
```

The paths under `/.iterate/` on every host are the platform's: a form that POSTs to
`/.iterate/sign-out` signs the person out.

A person who signs in from an app's host sees which app asks: the mind's sign-in pages show the
app's name and icon, its host, that the app learns their email address and no more, and that the
sign-in makes them no member. The app says its name and icon in a web app manifest at
`/manifest.webmanifest` on its own host (`name`, and `icons` with a `src` on the same host;
[apps.md](apps.md) says where an app keeps it). An app with no manifest is shown by its host and its initials. A changed manifest shows within five
minutes. A person, member or not, sees where they are signed in, and ends it, at
`https://iterate.<domain>/sessions`: their browsers, and each app that holds a sign-in as them.

A guestbook where anyone signed in keeps their own notes, each person's in a context of its own,
and only members see who wrote:

```ts
export default class extends IterateConfigEntrypoint {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/notes") {
      const refused = this.auth.requirePerson(request);
      if (refused) return refused;
      const person = this.auth.person(request)!;
      using itx = this.getItx();
      const notes = itx.cd(`/guestbook/${person.userId}`);
      if (request.method === "POST") {
        await notes.append({ type: "note-added", payload: { text: await request.text() } });
        await itx.cd("/guestbook").append({ type: "person-wrote", payload: person });
      }
      const { events } = await notes.readEvents(0, 100);
      return Response.json({ email: person.email, notes: events.map((event) => event.payload) });
    }
    if (url.pathname === "/notes/all") {
      const refused = this.auth.require(request);
      if (refused) return refused;
      using itx = this.getItx();
      const { events } = await itx.cd("/guestbook").readEvents(0, 100);
      return Response.json(events.map((event) => event.payload));
    }
    return new Response("Not found", { status: 404 });
  }
}
```

A person who is not a member never holds `itx`: only your code acts for them, so check every
path you build from their input stays under their own context.

`@iterate-com/ui/live` reads a context live, as the person viewing: guard the route with
`this.auth.require(request)`, and the page connects with the host's own session. A whole page and
its route, to copy beside `worker.ts`:
https://github.com/iterate/packages/blob/main/packages/ui/examples/mind-host-page.ts.

## A live view of one context

A page can give a person who is no member a live view of one context, for a chat with its agent.
Your code decides which person may have which context. Then answer the page's socket path with
`this.auth.personItx(request, path)`, and the platform serves the socket for that context alone:

```ts
if (url.pathname === "/chat/socket") {
  const refused = this.auth.requirePerson(request);
  if (refused) return refused;
  return this.auth.personItx(request, `/agents/support/${this.auth.person(request)!.userId}`);
}
```

Your code creates the agent there first (`itx.agents.create(path)`).

`personItx` takes `{ methods }` as `requirePerson` does, and refuses the same way. The page opens
the path as a WebSocket, as a capnweb session, and hands it to `@iterate-com/ui`'s chat as the
context. The session ends when the person's sign-in ends.

What the page can do, on that one context:

- read its log and follow it live, and read its subscriptions, its lent stubs and a facet's state
  (`itx.facets.get('<name>').snapshot()` or `….liveSnapshot()`);
- send its agent words: `agents.get(path).message(input)`. The event names the person as who
  asked, in `source.onBehalfOf`, with this host in `via.appPage`. It carries no `principal`;
- stop the agent's answer: the platform appends the stop in its own words;
- get a download URL for a file under the context's path.

What it cannot do: reach another context, or the mind's `itx`, or append any other event, or run
any other call. The context's own rewrite rules do not change what the socket reaches.

## The guestbook

`apps/guestbook` is a whole app for end users, to copy or to turn on. Anyone reads it at
`guestbook.<domain>`. Anyone signed in writes an entry or answers one. An entry waits until a
member approves it, and a member can remove any entry. Other agents write through the app's own
MCP server at `guestbook.<domain>/mcp`: an MCP client finds the mind's sign-in from there, its
person signs in, and its token is good for that host alone.

Each entry, approval and removal is an event on `/apps/guestbook` (`apps/guestbook/entries.ts`),
and the page is a reduction of that log.

It is off in a new mind. To turn it on:

1. In `worker.ts`, uncomment the three guestbook lines: the import, `guestbookApp()` and the
   `case "guestbook"` in `fetch`.
2. People who are not members sign in only when the stack's config opens that:
   `login.methods.email.anyone: true` mails a sign-in code to any address that asks (the stack
   must handle mail; at most 20 such codes an hour), and `login.methods.google` signs in anyone
   with a Google account. Without one of them, only members can write.
