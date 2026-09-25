/*
 * Tableside service worker — kitchen push alerts only (phase F).
 *
 * The browser keeps this alive independently of any open tab, which is the
 * whole point: a kitchen tablet whose Tableside tab is closed or asleep
 * still gets a new order, because the push service wakes this worker and
 * this worker shows the notification.
 *
 * Deliberately does nothing else. No caching, no offline mode, no fetch
 * handler: a stale cached dashboard in a kitchen is worse than no page, and
 * a fetch handler would sit between every request and the network for no
 * benefit to this feature.
 *
 * Plain JavaScript in public/ because it is served as-is from the site
 * root (so its scope covers /dashboard) and never bundled.
 */

self.addEventListener("install", () => {
  // Take over straight away rather than waiting for every old tab to
  // close — there is no cached state to migrate.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/*
 * The URL a notification may open. The server only ever sends dashboard
 * paths (src/lib/push/dispatch-core.ts#isSafeNotificationUrl); this checks
 * again on the device, so a malformed or unexpected payload can never turn
 * a notification into a link to somewhere else.
 */
function safeUrl(url) {
  return typeof url === "string" && /^\/dashboard(\/[a-z0-9/_-]*)?$/i.test(url)
    ? url
    : "/dashboard";
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }

  const title =
    typeof payload.title === "string" && payload.title
      ? payload.title
      : "Tableside";
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    // Re-alert even when replacing a notification with the same tag.
    renotify: typeof payload.tag === "string",
    // A kitchen alert should stay until someone deals with it, rather than
    // vanishing after a few seconds while the cook's hands are full.
    requireInteraction: true,
    data: { url: safeUrl(payload.url) },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Prefer an open Tableside tab: focus it and take it to the page.
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) {
          await client.focus();
          if ("navigate" in client) await client.navigate(url);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
