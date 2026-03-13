// ─── BROS OF ST. HYACINTH — SERVICE WORKER ───────────────────────────────────
// Handles Web Push notifications. Lives at /service-worker.js (public folder).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Bros of St. Hyacinth", body: "New activity in the chat." };
  try { data = event.data.json(); } catch {}

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, {
        body:    data.body,
        icon:    "/logo192.png",
        badge:   "/logo192.png",
        tag:     data.tag || "bsh-notification",
        renotify: true,
        data:    { url: data.url || "/" },
      }),
      // Set the app icon badge to the unread count sent by the server.
      // Supported on iOS 16.4+ and Android Chrome for installed PWAs.
      typeof self.navigator !== "undefined" && self.navigator.setAppBadge
        ? self.navigator.setAppBadge(data.badge || 1)
        : Promise.resolve(),
    ])
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          client.focus();
          return;
        }
      }
      if (self.clients.openWindow) self.clients.openWindow(target);
    })
  );
});
