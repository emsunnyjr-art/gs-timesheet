// Minimal no-op service worker. Its only job is to exist -- some browsers
// (mainly Android/Chrome) require an active service worker before they'll
// treat a site as "installable" to the home screen. It intentionally does
// no caching: every app here needs a live connection to Supabase to be
// useful, so offline caching of the HTML shell alone wouldn't help.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {}); // pass-through, no caching
