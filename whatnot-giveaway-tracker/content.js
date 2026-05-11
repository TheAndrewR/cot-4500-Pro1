// Inject the page-context WebSocket interceptor before the page's own scripts run
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
(document.head || document.documentElement).prepend(script);
// Remove the tag immediately — the script has already been evaluated
script.addEventListener('load', () => script.remove());

function getStreamerUsername() {
  const path = window.location.pathname;

  // https://www.whatnot.com/live/<username>
  const liveMatch = path.match(/^\/live\/([^/?#]+)/);
  if (liveMatch) return liveMatch[1];

  // https://www.whatnot.com/user/<username>/live
  const userMatch = path.match(/^\/user\/([^/?#]+)\/live/);
  if (userMatch) return userMatch[1];

  // Fallback: last non-empty path segment
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] || 'Unknown';
}

// Track the last productId we forwarded so the popup always shows the right streamer
let lastProductId = null;

window.addEventListener('message', (event) => {
  if (!event.data?.__whatnotTracker) return;
  if (event.source !== window) return;

  const username = getStreamerUsername();

  if (event.data.type === 'GIVEAWAY_DETECTED') {
    lastProductId = event.data.productId;
    chrome.runtime.sendMessage({
      type: 'GIVEAWAY_STARTED',
      username,
      productId: event.data.productId,
      startTime: event.data.startTime,
    });
  }

  if (event.data.type === 'GIVEAWAY_ENDED') {
    chrome.runtime.sendMessage({
      type: 'REMOVE_GIVEAWAY',
      username,
    });
  }
});
