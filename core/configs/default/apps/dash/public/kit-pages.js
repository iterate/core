// kit-pages.js — A PAGE'S PART OF THE KIT, LOADED WHEN ITS PAGE FIRST OPENS, ONCE. The Dash's
// overview loads none of them: the repo IDE, the charts and the YAML reader are most of what the
// kit weighs. app.js names each page's import (`kits`) and reads this store as it draws.
//
// What a page's part is at any moment is HERE and nowhere else, by the page's name:
//   {}            it loads, or nobody opened the page yet
//   { module }    it is here
//   { error }     it did not load, and stays so: a browser keeps a module's failed load for
//                 the life of the page, so only a reload of the page can load it
// A component that draws a page reads its own page's answer, so a part that arrives while another
// page is shown is there when its page is shown again, and a part that failed says so on its own
// page alone.

/** The store for `kits`, each a page's own `() => import(…)`. A page with no part of the kit (the
 *  overview) has an empty module, at once. `read` answers the same object until the page's
 *  answer changes, as a store's snapshot must. */
export function kitPages(kits) {
  const answers = new Map();
  const loading = new Set();
  const listeners = new Set();
  const NOTHING_YET = {};
  const NO_PART = { module: {} };
  const answer = (page, value) => {
    loading.delete(page);
    answers.set(page, value);
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    read: (page) => (kits[page] ? answers.get(page) || NOTHING_YET : NO_PART),
    /** Starts the page's import, once: not while it runs, and not when it has an answer. */
    load(page) {
      if (!kits[page] || loading.has(page) || answers.has(page)) return;
      loading.add(page);
      kits[page]().then(
        (module) => answer(page, { module }),
        (failure) =>
          answer(page, { error: failure instanceof Error ? failure.message : String(failure) }),
      );
    },
  };
}
