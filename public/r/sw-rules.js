/*
 * Which requests the guest menu worker (/r/sw.js) keeps a copy of.
 * Offline mode, phase 2. Plain JavaScript, loaded by the worker with
 * importScripts() and by tests/unit/guest-sw-rules.test.ts, which runs
 * this file against a stand-in `self`.
 *
 * Only these, and only GET:
 *   page   — a restaurant's landing page, its menu, and a dish page,
 *            opened as a real page load (not Next's in-app RSC fetches).
 *   static — the app's own built files under /_next/static/ (their names
 *            change with every deploy, so a saved copy is never wrong).
 *   image  — pictures the menu shows: dish photos and the app's images.
 * Everything else goes straight to the network untouched: the cart, the
 * order pages, receipts, the table-scan link that starts a session, every
 * server action, and of course anything outside /r/, which this worker's
 * scope can't even see.
 */
(function (root) {
  var PAGE = /^\/r\/[^/]+(\/menu|\/item\/[^/]+)?\/?$/;

  function classify(request, origin) {
    if (request.method !== "GET") return "none";
    var url;
    try {
      url = new URL(request.url);
    } catch {
      return "none";
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return "none";

    if (url.origin === origin) {
      if (url.pathname.indexOf("/_next/static/") === 0) return "static";
      if (url.pathname === "/_next/image") return "image";
      if (
        request.mode === "navigate" &&
        PAGE.test(url.pathname) &&
        // Next's in-app page fetches carry these; they're not whole pages.
        !url.searchParams.has("_rsc") &&
        !(request.headers && request.headers.get("RSC"))
      ) {
        return "page";
      }
      if (request.destination === "image") return "image";
      return "none";
    }

    return request.destination === "image" ? "image" : "none";
  }

  /** Oldest entries go first once a cache is over its limit. */
  var LIMITS = { static: 200, image: 80, page: 40 };

  /** A slow network falls back to the saved page after this long. */
  var PAGE_TIMEOUT_MS = 4000;

  var rules = { classify: classify, LIMITS: LIMITS, PAGE_TIMEOUT_MS: PAGE_TIMEOUT_MS };
  root.TablesideSwRules = rules;
})(typeof self !== "undefined" ? self : globalThis);
