import { JSDOM } from "jsdom";
import type { PageDriver } from "../../src/h12.ts";

// Runs the deployed demo page the way a browser would, in jsdom: it loads the page's HTML as the Worker served it, executes
// the page's own inline script, with the key, user and workspace in the address fragment, and reads what the page shows. jsdom
// has no network of its own, so the page's requests are handed to `send`. This stands in for the browser; it is not part of the
// product, so it is not covered by the "no glue code" scan.

export function jsdomPageDriver(send: (request: Request) => Promise<Response>): PageDriver {
  return {
    async open(pageUrl, fragment) {
      const html = await (await send(new Request(pageUrl))).text();
      const dom = new JSDOM(html, {
        url: `${pageUrl}#${fragment}`,
        runScripts: "dangerously",
        pretendToBeVisual: true,
        beforeParse(window) {
          (window as unknown as { fetch: unknown }).fetch = (input: string | URL | Request, init?: RequestInit) => send(new Request(typeof input === "string" || input instanceof URL ? String(input) : input.url, init));
        },
      });
      try {
        const deadline = Date.now() + 45_000;
        for (;;) {
          const document = dom.window.document;
          const shown = document.querySelector('[data-testid="balance"]')?.textContent ?? null;
          const alert = document.querySelector('[role="alert"]')?.textContent ?? null;
          if (shown !== null || alert !== null) return { shown, text: document.body.textContent ?? "" };
          if (Date.now() > deadline) return { shown: null, text: document.body.textContent ?? "" };
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        dom.window.close();
      }
    },
  };
}
