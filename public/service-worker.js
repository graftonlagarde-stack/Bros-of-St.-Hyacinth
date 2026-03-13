// ─── BROS OF ST. HYACINTH — SERVICE WORKER ───────────────────────────────────
// Handles Web Push notifications. Lives at /service-worker.js (public folder).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: "Bros of St. Hyacinth", body: "New activity in the chat." };
  try { data = event.data.json(); } catch {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    "/logo192.png",
      badge:   "/logo192.png",
      tag:     data.tag || "bsh-notification",
      renotify: true,
      data:    { url: data.url || "/" },
    })
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
