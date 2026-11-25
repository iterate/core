import { expect, test } from "vitest";
import {
  APP_DESCRIPTION_PATH,
  type AppDescription,
  serveAppDescription,
} from "./app-description.ts";
import { OwnerEmailPattern } from "./mind-config.ts";

test("the app's own object is answered as JSON at one well-known path, to anyone", async () => {
  expect(APP_DESCRIPTION_PATH).toBe("/.well-known/iterate-app");
  const answer = serveAppDescription(ask(APP_DESCRIPTION_PATH), GUESTBOOK);
  expect(answer).toMatchObject({ status: 200 });
  expect(answer!.headers.get("content-type")).toContain("application/json");
  expect(await answer!.json()).toEqual(GUESTBOOK);
  // an app for members that names no method says only what it wrote: the issuer has the default
  const dash: AppDescription = { name: "Dash", for: "members" };
  expect(await serveAppDescription(ask(`${APP_DESCRIPTION_PATH}?x=1`), dash)!.json()).toEqual(dash);
});

test("any other request is the app's own, and only a read is answered", () => {
  for (const path of ["/", "/.well-known/iterate", `${APP_DESCRIPTION_PATH}/x`, "/icon.svg"])
    expect(serveAppDescription(ask(path), GUESTBOOK), path).toBeNull();
  expect(
    serveAppDescription(ask(APP_DESCRIPTION_PATH, { method: "HEAD" }), GUESTBOOK),
  ).toMatchObject({ status: 200 });
  expect(
    serveAppDescription(ask(APP_DESCRIPTION_PATH, { method: "POST" }), GUESTBOOK),
  ).toMatchObject({ status: 405 });
});

test("a sign-in method that the issuer does not know is refused by the type, and as it is served", () => {
  // @ts-expect-error -- "google" is no sign-in method
  const outside: AppDescription = { name: "Guestbook", signIn: ["email", "google"] };
  expect(() => serveAppDescription(ask(APP_DESCRIPTION_PATH), outside)).toThrow(/signIn/);
  // @ts-expect-error -- a list names one method at least
  const none: AppDescription = { name: "Guestbook", signIn: [] };
  expect(() => serveAppDescription(ask(APP_DESCRIPTION_PATH), none)).toThrow(/signIn/);
  // @ts-expect-error -- an app is for members, or says nothing of whom it is for
  const everyone: AppDescription = { name: "Guestbook", for: "everyone" };
  expect(() => serveAppDescription(ask(APP_DESCRIPTION_PATH), everyone)).toThrow(/for/);
});

test("the addresses and the patterns of an app's people are served in lowercase, and a pattern that is no owner email pattern is refused as it is served", async () => {
  const shop: AppDescription = {
    name: "Shop",
    allowedEmails: ["eve@elsewhere.test"],
    allowedEmailPatterns: ["*@example.com", "*@second.example"],
  };
  expect(await serveAppDescription(ask(APP_DESCRIPTION_PATH), shop)!.json()).toEqual(shop);
  expect(
    await serveAppDescription(ask(APP_DESCRIPTION_PATH), {
      name: "Shop",
      allowedEmails: ["Eve@Elsewhere.test"],
    })!.json(),
  ).toEqual({ name: "Shop", allowedEmails: ["eve@elsewhere.test"] });
  // a list of domains is not read, and is not dropped in silence either
  expect(() =>
    serveAppDescription(ask(APP_DESCRIPTION_PATH), {
      name: "Shop",
      // @ts-expect-error -- no such field
      emailDomains: ["example.com"],
    }),
  ).toThrow(/emailDomains is not read/);
  // the same patterns as the mind config's, and no other spelling
  for (const pattern of ["example.com", "@example.com", "*@*.example.com", "*@Example.com", "*"]) {
    const says = { name: "Shop", allowedEmailPatterns: [pattern] };
    expect(OwnerEmailPattern.safeParse(pattern), pattern).toMatchObject({ success: false });
    expect(() => serveAppDescription(ask(APP_DESCRIPTION_PATH), says), pattern).toThrow(
      /allowedEmailPatterns/,
    );
  }
  for (const says of [
    { name: "Shop", allowedEmails: ["example.com"] },
    { name: "Shop", allowedEmails: [] },
  ])
    expect(() => serveAppDescription(ask(APP_DESCRIPTION_PATH), says)).toThrow(/allowedEmails/);
  expect(() =>
    serveAppDescription(ask(APP_DESCRIPTION_PATH), { name: "Shop", allowedEmailPatterns: [] }),
  ).toThrow(/allowedEmailPatterns/);
});

const GUESTBOOK: AppDescription = {
  name: "Guestbook",
  icon: "/icon.svg",
  signIn: ["email", "passkey"],
};
const ask = (path: string, init?: RequestInit) =>
  new Request(`https://guestbook.example.com${path}`, init);
