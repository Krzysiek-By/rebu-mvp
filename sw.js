self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch(e) {}
  const title = data.title || 'Sekretarz';
  const options = {
    body: data.body || 'Du hast eine neue Erinnerung.',
    tag: data.tag || 'sekretarz-reminder',
    data: { url: (data.url || '/') }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    for(const client of windows){
      if('focus' in client){
        try { await client.navigate(url); } catch(e) {}
        return client.focus();
      }
    }
    if(self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
