// Runs in page context (not extension context) — injected via <script> tag.
// Intercepts the page's own WebSocket to detect giveaway events without
// needing to re-authenticate.
(function () {
  const GIVEAWAY_DURATION_MS = 5 * 60 * 1000;
  const OriginalWebSocket = window.WebSocket;

  // productId -> true, prevents re-triggering for the same giveaway
  const activeProductIds = new Set();

  function postToExtension(type, payload) {
    window.postMessage({ __whatnotTracker: true, type, ...payload }, '*');
  }

  // Scan latestLiveActivityEvents (returned on channel join) for any giveaway
  // that started within the last 5 minutes and hasn't been won yet.
  function scanHistoricalEvents(events) {
    if (!Array.isArray(events)) return;

    const now = Date.now();
    let latestGiveawayStart = null;

    for (const evt of events) {
      const { eventName, timestamp, eventSpecificInfo } = evt;
      if (!eventName || !timestamp) continue;

      if (
        eventName === 'GIVEAWAY_STARTED' ||
        eventName === 'AUCTION_STARTED' ||
        eventName === 'GIVEAWAY_START'
      ) {
        const elapsed = now - timestamp;
        if (elapsed < GIVEAWAY_DURATION_MS) {
          if (!latestGiveawayStart || timestamp > latestGiveawayStart.timestamp) {
            latestGiveawayStart = { timestamp, productId: eventSpecificInfo?.productId };
          }
        }
      }

      // If we see AUCTION_WON more recent than any start, the giveaway is already over
      if (eventName === 'AUCTION_WON' && latestGiveawayStart) {
        if (timestamp > latestGiveawayStart.timestamp) {
          latestGiveawayStart = null;
        }
      }
    }

    if (latestGiveawayStart) {
      const { timestamp, productId } = latestGiveawayStart;
      const key = productId || String(timestamp);
      if (!activeProductIds.has(key)) {
        activeProductIds.add(key);
        setTimeout(() => activeProductIds.delete(key), GIVEAWAY_DURATION_MS + 60000);
        postToExtension('GIVEAWAY_DETECTED', {
          productId: key,
          startTime: timestamp,
        });
      }
    }
  }

  function attachListener(ws) {
    ws.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      // Phoenix wire format: [join_ref, ref, topic, event, payload]
      if (!Array.isArray(data) || data.length < 5) return;
      const [, , topic, eventName, payload] = data;
      if (typeof topic !== 'string' || !topic.startsWith('auction:')) return;

      // ── Real-time: giveaway is active (fires repeatedly while running) ──
      if (eventName === 'giveaway_entry_count_updated') {
        const productId = payload?.productId;
        if (!productId) return;
        if (!activeProductIds.has(productId)) {
          activeProductIds.add(productId);
          setTimeout(() => activeProductIds.delete(productId), GIVEAWAY_DURATION_MS + 60000);
          postToExtension('GIVEAWAY_DETECTED', {
            productId,
            startTime: Date.now(),
          });
        }
      }

      // ── Real-time: giveaway ended early (winner picked) ──
      if (eventName === 'auction_won' || eventName === 'giveaway_ended') {
        const productId = payload?.productId || payload?.auctionId;
        if (productId) {
          activeProductIds.delete(productId);
          postToExtension('GIVEAWAY_ENDED', { productId });
        }
      }

      // ── Channel join reply: check for active giveaway in history ──
      if (eventName === 'phx_reply' && payload?.status === 'ok') {
        const events = payload?.response?.latestLiveActivityEvents;
        if (events) scanHistoricalEvents(events);
      }
    });
  }

  // Monkey-patch WebSocket so every connection the page creates is intercepted
  function PatchedWebSocket(...args) {
    const ws = new OriginalWebSocket(...args);
    attachListener(ws);
    return ws;
  }

  PatchedWebSocket.prototype = OriginalWebSocket.prototype;
  PatchedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  PatchedWebSocket.OPEN = OriginalWebSocket.OPEN;
  PatchedWebSocket.CLOSING = OriginalWebSocket.CLOSING;
  PatchedWebSocket.CLOSED = OriginalWebSocket.CLOSED;
  Object.defineProperty(PatchedWebSocket, 'name', { value: 'WebSocket' });

  window.WebSocket = PatchedWebSocket;
})();
