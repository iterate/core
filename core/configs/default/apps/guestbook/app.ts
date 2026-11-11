// app.ts — THE GUESTBOOK, an app for people who are not members: its END USERS. Anyone reads it.
// Anyone who signs in at the mind's own sign-in writes an entry or answers one, as a user, and
// reaches nothing else of the mind. An entry waits until a member approves it; a member can remove
// any entry. Other agents write through the app's own MCP server at /mcp, signed in the same way.
//
// It is an example to copy: worker.ts mounts it with one line, which is commented out (AGENTS.md,
// "The guestbook"). People who are no members can sign in only when the stack's config says so
// (`login.methods.email.anyone`).
//
// The entries are events on one context of the mind (entries.ts). A user never holds `itx`: this
// code alone acts for them, and it builds no path from what they send.
import { serveFiles, type IterateConfigEntrypoint } from "iterate/sdk";
import type { Person } from "iterate/principal";
import {
  ENTRY_APPROVED,
  ENTRY_REMOVED,
  ENTRY_WRITTEN,
  entriesOf,
  GUESTBOOK_PATH,
  refusalOf,
  viewOf,
} from "./entries.ts";
import index from "./index.html";
import { mcpResponse, protectedResourceResponse } from "./mcp.ts";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

type Host = Pick<IterateConfigEntrypoint, "auth" | "getItx">;
type Viewer = { person: Person | null; member: boolean };

export function guestbookApp() {
  return {
    /** Every request on the app's host. worker.ts puts no guard before it: the page is public, and
     *  each route below asks for who it needs. */
    async fetch(request: Request, host: Host): Promise<Response> {
      const url = new URL(request.url);
      const person = host.auth.person(request);
      // `require` answers null for a member alone
      const viewer: Viewer = { person, member: Boolean(person) && !host.auth.require(request) };
      const book = guestbook(host);

      // a page load here signs the visitor in at the mind's sign-in, then comes back
      if (url.pathname === "/sign-in")
        return host.auth.requirePerson(request) || Response.redirect(`${url.origin}/`, 302);
      if (url.pathname === "/entries.json" && request.method === "GET")
        return Response.json(
          {
            viewer: { email: person?.email || null, member: viewer.member },
            entries: await book.view(viewer),
          },
          { headers: { "cache-control": "no-store" } },
        );
      if (url.pathname === "/entries" && request.method === "POST") {
        const refused = host.auth.requirePerson(request);
        if (refused) return refused;
        const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const written = await book.write(person!, input);
        return Response.json(written, { status: "refused" in written ? 400 : 200 });
      }
      const decision = /^\/entries\/(\d+)\/(approve|remove)$/.exec(url.pathname);
      if (decision && request.method === "POST") {
        const refused = host.auth.require(request);
        if (refused) return refused;
        const decided = await book.decide(
          person!,
          Number(decision[1]),
          decision[2] as "approve" | "remove",
        );
        return Response.json(decided, { status: "refused" in decided ? 404 : 200 });
      }
      // The MCP server, for other agents: a client finds the mind's sign-in through the document
      // below, signs its person in there, and calls with a token that is good for this host alone.
      const metadata = protectedResourceResponse(request);
      if (metadata) return metadata;
      if (url.pathname === "/mcp") return mcpResponse(request, { person, viewer, book });
      return serveFiles(request, { index, files });
    },
  };
}

export type Guestbook = ReturnType<typeof guestbook>;

function guestbook(host: Host) {
  const entries = async () => {
    using itx = host.getItx();
    const log = itx.cd(GUESTBOOK_PATH);
    const events = [];
    for (let after = 0; ;) {
      const page = await log.readEvents(after, 500);
      events.push(...page.events);
      if (page.atHead || page.scannedThroughOffset <= after) break;
      after = page.scannedThroughOffset;
    }
    return entriesOf(events);
  };
  return {
    view: async (viewer: Viewer) => viewOf(await entries(), viewer),
    async write(person: Person, input: { text?: unknown; replyTo?: unknown }) {
      const refused = refusalOf(await entries(), person, {
        text: input.text,
        replyTo: input.replyTo,
      });
      if (refused) return { refused };
      using itx = host.getItx();
      await itx.cd(GUESTBOOK_PATH).append({
        type: ENTRY_WRITTEN,
        payload: {
          text: String(input.text).trim(),
          // `refusalOf` let it through, so it is an approved entry's id
          replyTo: input.replyTo || undefined,
          by: { userId: person.userId, email: person.email },
        },
      });
      return { waiting: true };
    },
    async decide(member: Person, entry: number, decision: "approve" | "remove") {
      if (!(await entries()).has(entry)) return { refused: "There is no such entry." };
      using itx = host.getItx();
      await itx.cd(GUESTBOOK_PATH).append({
        type: decision === "approve" ? ENTRY_APPROVED : ENTRY_REMOVED,
        payload: { entry, by: { userId: member.userId, email: member.email } },
      });
      return { entry, decision };
    },
  };
}
