// Enables SharedArrayBuffer on static hosts by serving this file as both a
// page script and a service worker that adds COOP/COEP response headers.
if (typeof window === "undefined") {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  async function handleFetch(request) {
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
      return;
    }

    if (request.mode === "no-cors") {
      request = new Request(request.url, {
        cache: request.cache,
        credentials: "omit",
        headers: request.headers,
        integrity: request.integrity,
        destination: request.destination,
        keepalive: request.keepalive,
        method: request.method,
        mode: request.mode,
        redirect: request.redirect,
        referrer: request.referrer,
        referrerPolicy: request.referrerPolicy,
        signal: request.signal,
      });
    }

    const response = await fetch(request).catch((error) => console.error(error));
    if (!response) {
      return new Response("network error", { status: 502 });
    }
    if (response.status === 0) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Embedder-Policy", "credentialless");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  self.addEventListener("fetch", (event) => {
    event.respondWith(handleFetch(event.request));
  });
} else {
  (async function registerIsolationWorker() {
    if (window.crossOriginIsolated !== false) {
      return;
    }
    if (!("serviceWorker" in navigator)) {
      return;
    }

    const registration = await navigator.serviceWorker
      .register(window.document.currentScript.src)
      .catch((error) => console.error("COOP/COEP Service Worker failed to register:", error));

    if (!registration) {
      return;
    }

    console.log("COOP/COEP Service Worker registered", registration.scope);

    registration.addEventListener("updatefound", () => {
      console.log("Reloading page to use updated COOP/COEP Service Worker.");
      window.location.reload();
    });

    if (registration.active && !navigator.serviceWorker.controller) {
      console.log("Reloading page to use COOP/COEP Service Worker.");
      window.location.reload();
    }
  })();
}
