/*
 * Tableside guest menu worker — offline mode, phase 2.
 *
 * Keeps a copy of the menu on the guest's own phone, so when signal drops
 * they can still browse it. Its scope is /r/ (registered by
 * src/components/customer/guest-offline-support.tsx), so it never sees a
 * staff page: the kitchen's own worker (/sw.js) stays push-only, and a
 * stale dashboard can't happen.
 *
 * Network first, always. A saved page is used only when the network fails
 * or takes longer than PAGE_TIMEOUT_MS, and the page then says it's the
 * saved menu and when it was saved. Prices and what's available are
 * checked by the server when the order is sent, so a saved menu can't
 * place a wrong order.
 *
 * TO SWITCH IT OFF in an emergency: replace this file's body with
 *   self.addEventListener("install", () => self.skipWaiting());
 *   self.addEventListener("activate", (e) => e.waitUntil(
 *     caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k))))
 *       .then(() => self.registration.unregister())));
 * and deploy. Phones pick it up on their next visit.
 */

importScripts("/r/sw-rules.js");

var rules = self.TablesideSwRules;
var VERSION = "v1";
var CACHES = {
  page: "tableside-guest-pages-" + VERSION,
  static: "tableside-guest-static-" + VERSION,
  image: "tableside-guest-images-" + VERSION,
};
var SAVED_AT = "x-tableside-saved-at";

/* Which page each tab was given from the saved copy, and when it was saved. */
var servedFromCache = new Map();

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  var keep = Object.values(CACHES);
  event.waitUntil(
    caches
      .keys()
      .then(function (keys) {
        return Promise.all(
          keys
            .filter(function (k) {
              return k.indexOf("tableside-guest-") === 0 && keep.indexOf(k) === -1;
            })
            .map(function (k) {
              return caches.delete(k);
            }),
        );
      })
      .then(function () {
        return self.clients.claim();
      }),
  );
});

function trim(cacheName, limit) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      var extra = keys.length - limit;
      if (extra <= 0) return;
      return Promise.all(
        keys.slice(0, extra).map(function (k) {
          return cache.delete(k);
        }),
      );
    });
  });
}

function save(kind, request, response) {
  return caches
    .open(CACHES[kind])
    .then(function (cache) {
      return cache.put(request, response);
    })
    .then(function () {
      return trim(CACHES[kind], rules.LIMITS[kind]);
    })
    .catch(function () {
      // Out of space or refused: the network copy was still served.
    });
}

/* The page with the moment it was saved, for the "saved menu" note. */
function stamped(response) {
  return response.blob().then(function (body) {
    var headers = new Headers(response.headers);
    headers.set(SAVED_AT, String(Date.now()));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });
  });
}

function handlePage(event) {
  var request = event.request;
  var network = fetch(request).then(function (response) {
    if (response.ok && response.type === "basic" && !response.redirected) {
      var copy = response.clone();
      event.waitUntil(
        stamped(copy).then(function (s) {
          return save("page", request.url, s);
        }),
      );
    }
    return response;
  });

  var fromCache = function (reason) {
    return caches.open(CACHES.page).then(function (cache) {
      return cache.match(request.url).then(function (saved) {
        if (!saved) return undefined;
        var at = Number(saved.headers.get(SAVED_AT)) || null;
        if (event.resultingClientId) {
          servedFromCache.set(event.resultingClientId, {
            at: at,
            reason: reason,
          });
        }
        return saved;
      });
    });
  };

  var timedOut = new Promise(function (resolve) {
    setTimeout(resolve, rules.PAGE_TIMEOUT_MS, "timeout");
  });

  return Promise.race([network.catch(function () { return "failed"; }), timedOut]).then(
    function (winner) {
      if (winner instanceof Response) return winner;
      // "failed": no connection at all; "timeout": too slow to wait for.
      return fromCache(winner === "timeout" ? "slow" : "offline").then(function (saved) {
        // Nothing saved: keep waiting for the network, and let the
        // browser show its own offline page if that fails too.
        return saved || network;
      });
    },
  );
}

function handleStatic(event) {
  return caches.open(CACHES.static).then(function (cache) {
    return cache.match(event.request).then(function (saved) {
      if (saved) return saved;
      return fetch(event.request).then(function (response) {
        if (response.ok) event.waitUntil(save("static", event.request, response.clone()));
        return response;
      });
    });
  });
}

/*
 * Photos: the saved copy at once if there is one, refreshed behind it.
 * Fetched in cors mode so the saved copy isn't an "opaque" response,
 * which browsers count as several megabytes each against the phone's
 * storage; one that can't be fetched that way is shown but not saved.
 */
function handleImage(event) {
  var request = event.request;
  var refresh = fetch(request.url, { mode: "cors", credentials: "omit" })
    .then(function (response) {
      if (response.ok) event.waitUntil(save("image", request.url, response.clone()));
      return response;
    })
    .catch(function () {
      return fetch(request);
    });

  return caches.open(CACHES.image).then(function (cache) {
    return cache.match(request.url).then(function (saved) {
      if (saved) {
        event.waitUntil(refresh.catch(function () {}));
        return saved;
      }
      return refresh;
    });
  });
}

self.addEventListener("fetch", function (event) {
  var kind = rules.classify(event.request, self.location.origin);
  if (kind === "page") event.respondWith(handlePage(event));
  else if (kind === "static") event.respondWith(handleStatic(event));
  else if (kind === "image") event.respondWith(handleImage(event));
  // Anything else: not handled, so the browser goes to the network as usual.
});

/* A page asking whether it came from the saved copy, and from when. */
self.addEventListener("message", function (event) {
  var data = event.data || {};
  if (data.type !== "tableside-saved-at" || !event.source) return;
  var served = servedFromCache.get(event.source.id);
  servedFromCache.delete(event.source.id);
  event.source.postMessage({
    type: "tableside-saved-at",
    savedAt: (served && served.at) || null,
    reason: (served && served.reason) || null,
  });
});
