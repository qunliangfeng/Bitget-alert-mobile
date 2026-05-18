const CACHE_NAME = 'xibencong-v1';
const CACHE_FILES = [
  'xibencong-alert-mobile-701.html',
  'tiger.png',
  'manifest.json'
];

// 安装：缓存核心文件
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(CACHE_FILES).catch(() => {});
    })
  );
  self.skipWaiting();
});

// 激活：清除旧缓存
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// 请求拦截：网络优先，失败用缓存
self.addEventListener('fetch', (event) => {
  // 只处理同源请求，API 请求不缓存
  if (!event.request.url.startsWith(self.location.origin)) return;
  if (event.request.url.includes('workers.dev')) return;
  if (event.request.url.includes('api.')) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
