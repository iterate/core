import { expect, test } from "vitest";
import { openPageCommand } from "./open-page.ts";

const signIn = new URL(
  "https://iterate.example.com/authorize?response_type=code&client_id=cli&state=a|b&redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2Fcallback",
);

test("each platform opens the whole URL as one argument of a program that is no shell", () => {
  expect({
    mac: openPageCommand(signIn, "darwin"),
    windows: openPageCommand(signIn, "win32"),
    linux: openPageCommand(signIn, "linux"),
  }).toEqual({
    mac: { command: "open", args: [signIn.href] },
    // not `cmd /c start`: cmd reads `&` and `|` as its own, and this URL has both
    windows: { command: "rundll32", args: ["url.dll,FileProtocolHandler", signIn.href] },
    linux: { command: "xdg-open", args: [signIn.href] },
  });
});

test("a URL that a hostile mind's metadata names to run a command on Windows is one argument, and cmd is never the program", () => {
  const hostile = new URL("https://iterate.example.com/authorize?a=1&calc.exe&b=2|whoami");
  expect(openPageCommand(hostile, "win32")).toEqual({
    command: "rundll32",
    args: ["url.dll,FileProtocolHandler", hostile.href],
  });
});

test("a page that is neither https nor on this computer is refused on every platform, before any program is named", () => {
  const refused = [
    "http://iterate.example.com/authorize",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ms-msdt:/id PCWDiagnostic",
    "http://localhost.example.com/authorize",
    "ftp://localhost/authorize",
  ];
  for (const platform of ["darwin", "win32", "linux"] as const)
    for (const href of refused)
      expect(() => openPageCommand(new URL(href), platform), `${platform} ${href}`).toThrow(
        "not opened",
      );
});

test("a mind in local dev signs in over http on this computer", () => {
  for (const href of [
    "http://localhost:8788/authorize?a=1&b=2",
    "http://iterate.localhost:8789/authorize",
    "http://127.0.0.1:8788/authorize",
    "http://[::1]:8788/authorize",
  ])
    expect(openPageCommand(new URL(href), "linux")).toEqual({ command: "xdg-open", args: [href] });
});
