// Service Worker for DigiMap PWA
// Update this version number when you want to force cache refresh
const SW_VERSION = '6.3.4';
const CACHE_NAME = 'digimap-v' + SW_VERSION;
const RUNTIME_CACHE = 'digimap-runtime-v' + SW_VERSION;

// Firebase configuration (same as in firebase.js)
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCrGt2NQUElXsb86wVv5xVtZ-nQrN36_jM",
  authDomain: "database-e6887.firebaseapp.com",
  projectId: "database-e6887",
  storageBucket: "database-e6887.firebasestorage.app",
  messagingSenderId: "534397309409",
  appId: "1:534397309409:web:9c8885b29bcc5a5a1442a0"
};

// Network timeout for mobile (fail fast on slow connections)
const NETWORK_TIMEOUT = 3000; // 3 seconds

// Assets to cache on install - these will be dynamically updated
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.ico',
  '/icon-192x192.png',
  '/icon-512x512.png'
];

// Helper function to timeout fetch requests
function timeoutFetch(request, timeout = NETWORK_TIMEOUT) {
  return Promise.race([
    fetch(request),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Network timeout')), timeout)
    )
  ]);
}

// Helper function to send progress updates
function sendProgress(progress, message, current = null, total = null) {
  const progressData = {
    type: 'SW_UPDATE_PROGRESS',
    progress: progress,
    message: message,
    version: SW_VERSION,
    current: current,
    total: total
  };

  // Send to all clients
  self.clients.matchAll().then((clients) => {
    clients.forEach((client) => {
      try {
        client.postMessage(progressData);
      } catch (err) {
        console.log('[Service Worker] Error sending progress:', err);
      }
    });
  }).catch(err => {
    console.log('[Service Worker] Error getting clients:', err);
  });
}

// Install event - cache essential assets with progress tracking
self.addEventListener('install', (event) => {
  console.log('[Service Worker] Installing new version...');

  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('[Service Worker] Caching app shell');
        sendProgress(10, 'Starting update...');

        // Cache assets with progress tracking
        const totalAssets = PRECACHE_ASSETS.length;
        let cachedCount = 0;

        return Promise.all(
          PRECACHE_ASSETS.map((asset, index) => {
            return cache.add(asset).then(() => {
              cachedCount++;
              const progress = 10 + Math.floor((cachedCount / totalAssets) * 70);
              sendProgress(progress, `Caching assets (${cachedCount}/${totalAssets})...`);
            }).catch(err => {
              console.log('[Service Worker] Failed to cache:', asset, err);
              cachedCount++;
            });
          })
        ).then(() => {
          sendProgress(85, 'Finishing update...');
          // Skip waiting to activate immediately for fast update
          return self.skipWaiting();
        }).then(() => {
          sendProgress(100, 'Update completed! Reloading...');
        });
      })
      .catch(err => {
        console.log('[Service Worker] Install failed:', err);
        sendProgress(0, 'Update failed. Please try again.');
      })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  console.log('[Service Worker] Activating new version...');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      // Delete ALL old caches (except current ones)
      return Promise.all(
        cacheNames
          .filter((cacheName) => {
            return cacheName !== CACHE_NAME && cacheName !== RUNTIME_CACHE;
          })
          .map((cacheName) => {
            console.log('[Service Worker] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          })
      );
    })
      .then(() => {
        // Claim clients immediately
        return self.clients.claim();
      })
      .then(() => {
        // Notify all clients about the update
        return self.clients.matchAll().then(clients => {
          clients.forEach(client => {
            client.postMessage({
              type: 'SW_UPDATED',
              version: SW_VERSION,
              message: 'Service worker updated. Please reload.'
            });
          });
        });
      })
  );
});

// Fetch event - Network First strategy for HTML/JS, Cache First for static assets
self.addEventListener('fetch', (event) => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  const url = new URL(event.request.url);

  // Skip cross-origin requests
  if (url.origin !== self.location.origin) {
    return;
  }

  // Skip service worker and manifest requests (always fetch fresh)
  if (event.request.url.includes('/service-worker.js') ||
    event.request.url.includes('/manifest.json')) {
    return;
  }

  const requestUrl = event.request.url;

  // Stale-While-Revalidate for HTML (show cached immediately, update in background)
  if (requestUrl.endsWith('.html') || requestUrl === '/' || event.request.mode === 'navigate') {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        // Start fetching fresh version in background
        const fetchPromise = timeoutFetch(event.request)
          .then((response) => {
            // Update cache if successful
            if (response && response.status === 200) {
              const responseToCache = response.clone();
              caches.open(RUNTIME_CACHE).then((cache) => {
                cache.put(event.request, responseToCache);
              });
            }
            return response;
          })
          .catch(() => {
            // Network failed, ignore (we'll use cache)
            return null;
          });

        // Return cached version immediately if available, otherwise wait for network
        if (cachedResponse) {
          return cachedResponse;
        }
        // If no cache, wait for network (with fallback)
        return fetchPromise.then((response) => {
          if (response) return response;
          // Fallback to index.html if navigation request
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html') || caches.match('/');
          }
          return new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({ 'Content-Type': 'text/plain' })
          });
        });
      })
    );
    return;
  }

  // Cache First for JS/CSS assets (they have hashes, safe to cache aggressively)
  if (requestUrl.endsWith('.js') ||
    requestUrl.endsWith('.css') ||
    requestUrl.includes('/assets/')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          // Update cache in background
          timeoutFetch(event.request)
            .then((response) => {
              if (response && response.status === 200) {
                const responseToCache = response.clone();
                caches.open(RUNTIME_CACHE).then((cache) => {
                  cache.put(event.request, responseToCache);
                });
              }
            })
            .catch(() => {
              // Network failed, keep using cache
            });
          return cachedResponse;
        }
        // No cache, fetch from network
        return timeoutFetch(event.request)
          .then((response) => {
            if (response && response.status === 200) {
              const responseToCache = response.clone();
              caches.open(RUNTIME_CACHE).then((cache) => {
                cache.put(event.request, responseToCache);
              });
            }
            return response;
          })
          .catch(() => {
            return new Response('Offline', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: new Headers({ 'Content-Type': 'text/plain' })
            });
          });
      })
    );
    return;
  }

  // Cache First strategy for static assets (images, fonts, etc.)
  event.respondWith(
    caches.match(event.request)
      .then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }

        // Otherwise fetch from network with timeout
        return timeoutFetch(event.request)
          .then((response) => {
            // Don't cache non-successful responses
            if (!response || response.status !== 200 || response.type !== 'basic') {
              return response;
            }

            // Clone the response
            const responseToCache = response.clone();

            // Cache the response
            caches.open(RUNTIME_CACHE)
              .then((cache) => {
                cache.put(event.request, responseToCache);
              })
              .catch((err) => {
                console.log('[Service Worker] Cache put failed:', err);
              });

            return response;
          })
          .catch((error) => {
            console.log('[Service Worker] Fetch failed:', error);
            return new Response('Offline', {
              status: 503,
              statusText: 'Service Unavailable',
              headers: new Headers({
                'Content-Type': 'text/plain'
              })
            });
          });
      })
  );
});

// Listen for messages from the page
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // Respond to version requests
  if (event.data && event.data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: SW_VERSION });
  }
});

// Background sync for offline actions (optional)
self.addEventListener('sync', (event) => {
  console.log('[Service Worker] Background sync:', event.tag);
  // Implement background sync logic here if needed
});

// Import Firebase Messaging SDK for background messages
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.0/firebase-messaging-compat.js');

// Initialize Firebase in Service Worker
firebase.initializeApp(FIREBASE_CONFIG);
const messaging = firebase.messaging();

// Counter for unique notification IDs to ensure no replacements
let notificationCounter = 0;

// Helper function to generate truly unique ID (UUID-like)
function generateUniqueId() {
  notificationCounter++;
  const timestamp = Date.now();
  const perfNow = performance.now();
  const random1 = Math.random().toString(36).substr(2, 9);
  const random2 = Math.random().toString(36).substr(2, 9);
  const random3 = Math.random().toString(36).substr(2, 9);
  const random4 = Math.random().toString(36).substr(2, 9);
  // Create a truly unique tag that will never collide
  return `digimap-${notificationCounter}-${timestamp}-${perfNow}-${random1}-${random2}-${random3}-${random4}`;
}

/**
 * Show notification without grouping - all notifications appear separately
 * 
 * WHY REPLACEMENT WAS HAPPENING:
 * - Using same tag causes browser to replace notifications
 * - collapse_key in FCM payload can cause replacement
 * - Not having unique notificationId allows duplicates
 * 
 * HOW IT'S FIXED:
 * - Use unique notificationId from backend (timestamp-based)
 * - No tag OR unique tag per notification ensures no replacement
 * - Each notification gets unique identifier in data
 */
async function showNotificationWithoutGrouping(title, body, icon, data, image) {
  // Get unique notificationId from backend payload (timestamp-based)
  // If not provided, generate one as fallback
  const notificationId = data?.notificationId || generateUniqueId();
  
  // Get all existing notifications to check for duplicates
  const allExistingNotifications = await self.registration.getNotifications();
  
  // Check for duplicate notification using notificationId (more reliable than title+body)
  const isDuplicate = allExistingNotifications.some(notif => {
    const existingId = notif.data?.notificationId;
    // If same notificationId exists, it's a duplicate
    return existingId && existingId === notificationId;
  });
  
  // If duplicate, skip showing
  if (isDuplicate) {
    console.log('[Service Worker] Duplicate notification detected (same notificationId), skipping:', notificationId);
    return Promise.resolve();
  }
  
  // Generate unique tag for this notification to prevent replacement
  // Each notification gets its own unique tag based on notificationId
  const uniqueTag = `digimap-${notificationId}`;
  
  console.log('[Service Worker] Showing notification:', { 
    title, 
    body, 
    notificationId,
    tag: uniqueTag 
  });
  
  const notificationOptions = {
    body: body,
    icon: icon || '/icon-192x192.png',
    badge: '/icon-192x192.png',
    image: image,
    vibrate: [200, 100, 200],
    tag: uniqueTag, // Unique tag per notificationId prevents replacement
    renotify: false, // Explicitly prevent replacement behavior
    data: {
      ...data,
      notificationId: notificationId // Store unique ID for duplicate detection
    },
    requireInteraction: false,
    silent: false,
    timestamp: Date.now()
  };
  
  return self.registration.showNotification(title, notificationOptions);
}

/**
 * Firebase Cloud Messaging background message handler
 * 
 * This ONLY fires when app is in background or killed state.
 * When app is in foreground, onMessage() in fcmClient.js handles it (but we disable UI there).
 * 
 * REQUIREMENT: Only show notifications in background/killed state, NOT in foreground.
 */
messaging.onBackgroundMessage((payload) => {
  console.log('[Service Worker] FCM background message received (app in background/killed):', payload);

  // Extract notification data from payload
  // Backend sends data-only payload (best practice to prevent double notifications)
  const notificationTitle = payload.data?.title || 'DigiMap';
  const notificationBody = payload.data?.body || 'New notification';
  const notificationIcon = payload.data?.icon || '/icon-192x192.png';
  const notificationImage = payload.data?.image;
  const notificationData = payload.data || {};

  // Verify notificationId exists (backend should always provide it)
  if (!notificationData.notificationId) {
    console.warn('[Service Worker] Missing notificationId in payload, generating fallback');
    notificationData.notificationId = generateUniqueId();
  }

  // Show notification (only in background/killed state)
  return showNotificationWithoutGrouping(
    notificationTitle,
    notificationBody,
    notificationIcon,
    notificationData,
    notificationImage
  );
});

// Push notification handler - fallback for non-FCM push notifications
self.addEventListener('push', (event) => {
  console.log('[Service Worker] Generic push notification received');

  // Check if this is an FCM notification - if so, skip it (handled by onBackgroundMessage)
  // FCM notifications are handled by messaging.onBackgroundMessage, so we skip them here
  if (event.data) {
    try {
      const payload = event.data.json();
      // FCM notifications typically have these identifiers:
      // - 'from' field with sender ID
      // - 'gcm.message_id' or 'google.c.a.e' fields
      // - 'fcmMessageId' or 'messageId' fields
      // - 'collapse_key' field
      // If payload has notification field, FCM will handle it automatically
      const isFCMNotification = payload.from || 
                                payload['gcm.message_id'] || 
                                payload['google.c.a.e'] || 
                                payload.fcmMessageId || 
                                payload.messageId ||
                                payload.collapse_key ||
                                (payload.notification && typeof payload.notification === 'object');
      
      if (isFCMNotification) {
        console.log('[Service Worker] FCM notification detected, skipping push handler (will be handled by onBackgroundMessage)');
        return; // FCM will handle it via onBackgroundMessage
      }
    } catch (e) {
      // If parsing fails, continue with generic handler
      console.log('[Service Worker] Error parsing push payload:', e);
    }
  }

  let title = 'DigiMap';
  let body = 'New update available';
  let data = {};
  let icon = '/icon-192x192.png';
  let image = null;

  // Handle data-only payload (preferred to prevent double notifications)
  if (event.data) {
    try {
      const payload = event.data.json();
      if (payload.data) {
        // Data-only payload (from backend)
        title = payload.data.title || title;
        body = payload.data.body || body;
        data = payload.data;
        icon = payload.data.icon || icon;
        image = payload.data.image || null;
      } else if (payload.notification) {
        // Notification payload (fallback) - but only if not FCM
        title = payload.notification.title || title;
        body = payload.notification.body || body;
        data = payload.data || {};
        icon = payload.notification.icon || icon;
        image = payload.notification.image || null;
      } else {
        // Plain text payload (fallback)
        body = event.data.text() || body;
      }
    } catch (e) {
      // If JSON parsing fails, try text
      body = event.data.text() || body;
    }
  }

  // Ensure notificationId exists (backend should provide it, but fallback if missing)
  if (!data.notificationId) {
    data.notificationId = generateUniqueId();
  }

  event.waitUntil(
    showNotificationWithoutGrouping(title, body, icon, data, image)
  );
});

// Notification click handler - handles both FCM and generic notifications
self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notification clicked:', event.notification);

  event.notification.close();

  const notificationData = event.notification.data || {};
  const notificationType = notificationData.type;
  
  // Get URL from notification data
  const urlToOpen = notificationData.url || '/';

  // Handle service worker update notifications
  if (notificationType === 'sw-update' || notificationType === 'sw-activated') {
    event.waitUntil(
      clients.matchAll({
        type: 'window',
        includeUncontrolled: true
      }).then((clientList) => {
        // Focus existing window or open new one
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ('focus' in client) {
            return client.focus();
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(urlToOpen);
        }
      })
    );
    return;
  }

  // Handle other notifications (FCM, etc.)
  event.waitUntil(
    clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    }).then((clientList) => {
      // Check if there's already a window/tab open with the target URL
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus();
        }
      }
      // If no window is open, open a new one
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
