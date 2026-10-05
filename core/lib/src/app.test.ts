import { newHttpBatchRpcResponse, RpcTarget } from "capnweb";
import { expect, test, vi } from "vitest";
import { createIterateClient } from "./app.ts";

test("sign-in starts the probe, the info read and the socket at once, and resolves before the socket has opened", async () => {
  const page = fakePage(200);
  const { info, read } = await createIterateClient().authenticate("/home");
  expect(info).toEqual({ principal: { actor: "user_ada" }, scopes: ["iterate"] });
  expect(page).toMatchObject({ events: ["socket wss://dash.test/api", "probe", "batch info"] });
  expect(page.socket()).toMatchObject({ readyState: WebSocket.CONNECTING });
  // plain data before the socket opens: one HTTP batch
  expect(await read((api) => api.projects.list())).toEqual([{ id: "prj_1", slug: "acme" }]);
  expect(page.events.at(-1)).toBe("batch projects.list");
  // once it is open, the socket
  page.open();
  // the connection's queued `authenticate` goes out once the socket it was adopted on has opened
  await vi.waitFor(() => expect(page.sent).toHaveLength(1));
  void read((api) => api.projects.list());
  await vi.waitFor(() => expect(page.sent.join("\n")).toContain('["projects","list"]'));
  expect(page.events.filter((event) => event.startsWith("batch"))).toHaveLength(2);
});

test("a 401 leaves for login and closes the socket it started, unused", async () => {
  const page = fakePage(401);
  void createIterateClient().authenticate("/home");
  await vi.waitFor(() =>
    expect(page.events).toContain("leave /.auth/login?scope=iterate&next=%2Fhome"),
  );
  page.open();
  await vi.waitFor(() => expect(page.events).toContain("socket closed"));
});

test("an outage fails the sign-in and closes the socket it started", async () => {
  const page = fakePage(503);
  await expect(createIterateClient().authenticate("/home")).rejects.toThrow(
    "iterate is unavailable (503). Please retry.",
  );
  page.open();
  await vi.waitFor(() => expect(page.events).toContain("socket closed"));
});

/** A page on https://dash.test: its probe (`POST /api`, empty) answers `status`; an HTTP batch on
 *  `/api` is answered by capnweb's own server over a fake session API; its WebSocket opens when
 *  `open()` is called and records what is sent. `events` is what happened, in order. */
function fakePage(status: number) {
  const events: string[] = [];
  const sent: string[] = [];
  let socket: (EventTarget & { readyState: number }) | undefined;
  vi.stubGlobal("window", {
    location: {
      href: "https://dash.test/home",
      assign: (url: string) => events.push(`leave ${url}`),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body || "");
    if (!body) {
      events.push("probe");
      return new Response(null, { status });
    }
    events.push(
      `batch ${/"pipeline",1,\["([a-z.",]+)"\]/.exec(body)?.[1]?.replaceAll('","', ".")}`,
    );
    return newHttpBatchRpcResponse(
      new Request(new URL(String(input), "https://dash.test"), { method: "POST", body }),
      new FakeApi(),
    );
  });
  vi.stubGlobal(
    "WebSocket",
    Object.assign(
      class extends EventTarget {
        readyState = 0;
        constructor(url: URL) {
          super();
          events.push(`socket ${url}`);
          socket = this;
        }
        send(data: string) {
          sent.push(data);
        }
        close() {
          events.push("socket closed");
        }
      },
      { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 },
    ),
  );
  return {
    events,
    sent,
    socket: () => socket,
    open() {
      socket!.readyState = 1;
      socket!.dispatchEvent(new Event("open"));
    },
  };
}

/** The platform's `/api` as far as these tests read it: a cookie session's info and projects. */
class FakeApi extends RpcTarget {
  authenticate() {
    return new FakeSession();
  }
}
class FakeSession extends RpcTarget {
  info() {
    return { principal: { actor: "user_ada" }, scopes: ["iterate"] };
  }
  get projects() {
    return new FakeProjects();
  }
}
class FakeProjects extends RpcTarget {
  list() {
    return [{ id: "prj_1", slug: "acme" }];
  }
}
