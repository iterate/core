// The default config's Dash (core/configs/default/apps/dash): the store of each page's part of
// the kit (public/kit-pages.js), which the page's script reads as it draws.
import { expect, test, vi } from "vitest";

type KitPages = {
  subscribe(listener: () => void): () => void;
  read(page: string): { module?: object; error?: string };
  load(page: string): void;
};

test("a part that arrives while its page is not shown is there when the page is shown again: no 'Loading the page…' that stays", async () => {
  const repo = Promise.withResolvers<object>();
  const pages = await kitPagesOf({ repo: () => repo.promise });
  // the page opens: its part loads, and the page listens
  pages.load("repo");
  const leave = pages.subscribe(() => {});
  expect(pages.read("repo")).toEqual({});
  // the person goes to another page, and the part arrives with nobody listening
  leave();
  const module = { RepoIde: () => null };
  repo.resolve(module);
  await repo.promise;
  // back on the page, its first draw has the part: nothing has to tell it
  expect(pages.read("repo")).toEqual({ module });
  // and opening the page again starts no second import
  const heard = vi.fn();
  pages.subscribe(heard);
  pages.load("repo");
  expect(heard).not.toHaveBeenCalled();
});

test("a page that listens while its part loads hears when it is here, and reads the same answer until it changes", async () => {
  const secrets = Promise.withResolvers<object>();
  const pages = await kitPagesOf({ secrets: () => secrets.promise });
  const heard = vi.fn();
  pages.subscribe(heard);
  pages.load("secrets");
  pages.load("secrets");
  // a store's snapshot: the same object for the same answer
  expect(pages.read("secrets")).toBe(pages.read("secrets"));
  secrets.resolve({ SecretsPage: () => null });
  await secrets.promise;
  expect(heard).toHaveBeenCalledTimes(1);
  expect(pages.read("secrets")).toBe(pages.read("secrets"));
});

test("a part that did not load says so on its own page alone, and its page's next opening asks no second time", async () => {
  const imports = vi
    .fn<() => Promise<object>>()
    .mockRejectedValue(new Error("Failed to fetch dynamically imported module"));
  const pages = await kitPagesOf({ repo: imports, secrets: () => new Promise<object>(() => {}) });
  pages.load("repo");
  await vi.waitFor(() => expect(pages.read("repo").error).toBeDefined());
  expect(pages.read("repo")).toEqual({ error: "Failed to fetch dynamically imported module" });
  // another page, and the overview, which has no part of the kit, do not show that failure
  expect(pages.read("secrets")).toEqual({});
  expect(pages.read("overview")).toEqual({ module: {} });
  // the page is opened again: no second import (public/kit-pages.js says why)
  pages.load("repo");
  expect(pages.read("repo")).toEqual({ error: "Failed to fetch dynamically imported module" });
  expect(imports).toHaveBeenCalledTimes(1);
});

/** The store as the Dash's page gets it: the page's own module, loaded by its address (it is a
 *  script of a no-build page, with no types). */
async function kitPagesOf(kits: Record<string, () => Promise<object>>): Promise<KitPages> {
  const { kitPages } = (await import(
    new URL("../../configs/default/apps/dash/public/kit-pages.js", import.meta.url).href
    // the page's script has no declaration file: its one export is the store this file describes
  )) as { kitPages(kits: Record<string, () => Promise<object>>): KitPages };
  return kitPages(kits);
}
