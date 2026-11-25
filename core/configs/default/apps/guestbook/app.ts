// app.ts — THE GUESTBOOK, an app for people who are not members: its END USERS. Anyone reads it.
// Anyone who signs in at the mind's own sign-in writes an entry or answers one, as a user, and
// reaches nothing else of the mind. An entry waits until a member approves it; a member can remove
// any entry. Other agents write through the app's own MCP server at /mcp, signed in the same way.
//
// It is an example to copy: worker.ts mounts it with three lines, and one method for its MCP
// server (people.md, "The guestbook"). A person who is no member signs in with a code that the mind mails to their
// address: the app names "email" first (`GUESTBOOK`), so the sign-in page opens on the address
// form, and the mail comes from this hostname's zone under the app's name.
//
// The entries are events on one context of the mind (entries.ts). A user never holds `itx`: this
// code alone acts for them, and it builds no path from what they send.
import {
  type AppDescription,
  serveFiles,
  type IterateConfigEntrypoint,
  type McpClient,
} from "iterate/sdk";
import type { Person } from "iterate/principal";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import liveReload from "../live-reload/";
import { openFile } from "../open-files.ts";
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
import { GuestbookMcp } from "./mcp.ts";
// oxlint-disable-next-line import/extensions -- a folder: the loader hands over every file under it, by path
import files from "./public/";

/** WHAT THE GUESTBOOK SAYS OF ITSELF, to the mind's sign-in pages: its name, its icon, and how
 *  its people sign in. The list is the default of an app that is not for members, written out:
 *  the mailed code first, and a member's passkey below it. Name "passkey" alone and only members
 *  sign in here. */
const GUESTBOOK: AppDescription = {
  name: "Guestbook",
  icon: "/icon.svg",
  signIn: ["email", "passkey"],
};

type Host = Pick<IterateConfigEntrypoint, "auth" | "getItx">;
type Viewer = { person: Person | null; member: boolean };

export function guestbookApp() {
  return {
    /** The class of the app's MCP server, for the client that asks (mcp.ts). worker.ts answers it
     *  from a method named `guestbookMcp`, which `fetch` below names to the platform. */
    mcp: (client: McpClient, host: Host) => new GuestbookMcp(client, guestbook(host)),

    /** Every request on the app's host. worker.ts puts no guard before it: the page is public, and
     *  each route below asks for who it needs. */
    async fetch(request: Request, host: Host): Promise<Response> {
      const described = openFile(request, GUESTBOOK);
      if (described) return described;
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
      // The MCP server, for other agents, at /mcp. The platform serves it: it sends a client to the
      // mind's sign-in, lets in anyone who signed in with an address ("people"), and asks the
      // method `guestbookMcp` of worker.ts for the class whose methods are the tools (mcp.ts).
      const mcp = host.auth.mcpServer(request, {
        target: "guestbookMcp",
        for: "people",
        name: `guestbook at ${url.hostname}`,
      });
      if (mcp) return mcp;
      // the app's own files, and the one script that every app of this mind shares
      return serveFiles(request, { index, files: { ...files, ...liveReload } });
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
