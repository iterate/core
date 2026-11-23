// The default config's worker as a test builds it: its constructor runs, so the fields that its
// `fetch` reads (`auth`, `getItx`, core/configs/default/worker.ts) are there, which
// `Object.create(Config.prototype)` leaves out. The runtime sets `ctx`; here it is
// one whose `waitUntil` keeps nothing. `properties` go over the instance, as
// `Object.create`'s second argument would.
import { vi } from "vitest";
import Config from "../../../configs/default/worker.ts";

export function defaultConfigInstance(properties: PropertyDescriptorMap = {}): Config {
  const config = new Config({ waitUntil() {}, props: {} } as never, {} as never);
  return Object.defineProperties(config, {
    ctx: { value: { waitUntil() {}, props: {}, exports: {} } },
    ...properties,
  });
}

/** A stand-in for workerd's `HTMLRewriter`, as much of it as the page tag asks
 *  (apps/telemetry/page-events.ts `withPageTag`): `on(selector)` with `element.prepend`, in the
 *  order the selectors were given, and `onDocument` with `end.append`, on the page's text. It
 *  stands in for the global while the test runs (vitest's `unstubGlobals` puts it back). The tag's
 *  own forms are checked in apps/telemetry/page-events.test.mjs. */
export function stubHtmlRewriter() {
  type Prepend = { prepend(content: string, options: { html: boolean }): unknown };
  type Append = { append(content: string, options: { html: boolean }): unknown };
  class TextRewriter {
    readonly #on: [string, { element?(element: Prepend): void }][] = [];
    #end?: (end: Append) => void;
    on(selector: string, handler: { element?(element: Prepend): void }) {
      this.#on.push([selector, handler]);
      return this;
    }
    onDocument(handler: { end?(end: Append): void }) {
      this.#end = handler.end?.bind(handler);
      return this;
    }
    transform(response: Response) {
      const rewrite = async () => {
        let html = await response.text();
        for (const [selector, handler] of this.#on) {
          const open = new RegExp(`<${selector}(\\s[^>]*)?>`, "i").exec(html);
          if (!open || !handler.element) continue;
          const at = open.index + open[0].length;
          handler.element({
            prepend: (content) => (html = html.slice(0, at) + content + html.slice(at)),
          });
        }
        this.#end?.({ append: (content) => (html += content) });
        return html;
      };
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(await rewrite()));
          controller.close();
        },
      });
      return new Response(body, response);
    }
  }
  vi.stubGlobal("HTMLRewriter", TextRewriter);
}
