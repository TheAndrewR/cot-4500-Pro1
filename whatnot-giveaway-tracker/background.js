// ── Constants ──────────────────────────────────────────────────────────────────
const GIVEAWAY_MS       = 5 * 60 * 1000;
const HEARTBEAT_MS      = 25_000;
const POLL_OFFLINE_MS   = 90_000;  // retry not-live streamers every 90s
const RECONNECT_DELAYS  = [4_000, 8_000, 20_000, 45_000, 90_000];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── In-memory state ────────────────────────────────────────────────────────────
// streamerInfo : Map<username, { status, livestreamId? }>
//   status: 'connecting' | 'live' | 'offline' | 'error' | 'not_found'
// wsConns      : Map<username, { ws, heartbeatId, reconnectId, seenProducts }>
// giveaways    : Map<username, { startTime, productId }>
const streamerInfo = new Map();
const wsConns      = new Map();
const giveaways    = new Map();

// ── Startup: restore watched usernames from storage ────────────────────────────
async function init() {
  const { watchedUsernames = [] } = await chrome.storage.local.get('watchedUsernames');
  for (const u of watchedUsernames) {
    if (!streamerInfo.has(u)) connectToStreamer(u);
  }
}

init();
// Re-init whenever the service worker wakes after being terminated
chrome.runtime.onStartup.addListener(init);

// ── Message handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  switch (msg.type) {
    case 'ADD_STREAMER':    handleAdd(msg.username).then(respond);    break;
    case 'REMOVE_STREAMER': handleRemove(msg.username).then(respond); break;
    case 'GET_STATE':       respond(buildState());                    break;
    case 'DISMISS_GIVEAWAY':
      giveaways.delete(msg.username);
      chrome.alarms.clear(`ga_end_${msg.username}`);
      respond({ ok: true });
      break;
  }
  return true; // keep channel open for async respond
});

// ── Alarms: giveaway expiry ────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name.startsWith('ga_end_')) {
    giveaways.delete(name.replace('ga_end_', ''));
  }
  if (name.startsWith('poll_')) {
    const username = name.replace('poll_', '');
    if (streamerInfo.has(username)) connectToStreamer(username);
  }
});

// ── Add / remove streamers ─────────────────────────────────────────────────────
async function handleAdd(username) {
  username = username.toLowerCase().trim();
  if (streamerInfo.has(username)) return { error: 'already_added' };

  const { watchedUsernames = [] } = await chrome.storage.local.get('watchedUsernames');
  if (!watchedUsernames.includes(username)) {
    await chrome.storage.local.set({ watchedUsernames: [...watchedUsernames, username] });
  }

  connectToStreamer(username);
  return { ok: true };
}

async function handleRemove(username) {
  teardown(username);
  streamerInfo.delete(username);
  giveaways.delete(username);
  chrome.alarms.clear(`ga_end_${username}`);
  chrome.alarms.clear(`poll_${username}`);

  const { watchedUsernames = [] } = await chrome.storage.local.get('watchedUsernames');
  await chrome.storage.local.set({
    watchedUsernames: watchedUsernames.filter(u => u !== username),
  });
  return { ok: true };
}

// ── Teardown a connection without removing the streamer ────────────────────────
function teardown(username) {
  const conn = wsConns.get(username);
  if (!conn) return;
  clearInterval(conn.heartbeatId);
  clearTimeout(conn.reconnectId);
  try { conn.ws?.close(); } catch {}
  wsConns.delete(username);
}

// ── Fetch livestream info from Whatnot (uses user's cookies) ──────────────────
async function fetchStreamerInfo(username) {
  let html;
  try {
    const resp = await fetch(`https://www.whatnot.com/live/${username}`, {
      credentials: 'include',
    });
    if (resp.status === 404) return { error: 'not_found' };
    if (!resp.ok)            return { error: 'fetch_failed' };
    html = await resp.text();
  } catch {
    return { error: 'network_error' };
  }

  // CSRF token (Phoenix apps put this in a meta tag)
  const csrfMatch = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/);
  const csrfToken = csrfMatch?.[1] ?? null;

  // Next.js data blob (Whatnot runs on Next.js)
  const ndMatch = html.match(/<script id=["']__NEXT_DATA__["'][^>]*>(\{[\s\S]*?\})<\/script>/);
  if (!ndMatch) return { error: 'no_next_data', csrfToken };

  let nd;
  try { nd = JSON.parse(ndMatch[1]); }
  catch { return { error: 'parse_failed', csrfToken }; }

  const result = { csrfToken };
  deepSearch(nd, result, 0);

  if (!result.livestreamId) return { error: 'not_live', csrfToken };
  return result;
}

// Recursively walk the Next.js data object looking for what we need
function deepSearch(obj, out, depth) {
  if (depth > 25 || !obj || typeof obj !== 'object') return;

  for (const [key, val] of Object.entries(obj)) {
    const k = key.toLowerCase();

    if (typeof val === 'string') {
      // Livestream UUID
      if (!out.livestreamId && UUID_RE.test(val) &&
          (k === 'livestreamid' || k === 'id' || k.includes('livestream'))) {
        out.livestreamId = val;
      }
      // Phoenix session token
      if (!out.sessionExtensionToken &&
          (k.includes('sessionextension') || val.startsWith('SFMyNTY'))) {
        out.sessionExtensionToken = val;
      }
      // CSRF fallback
      if (!out.csrfToken && k.includes('csrf')) {
        out.csrfToken = val;
      }
    } else if (Array.isArray(val)) {
      for (const item of val) deepSearch(item, out, depth + 1);
    } else if (val && typeof val === 'object') {
      deepSearch(val, out, depth + 1);
    }
  }
}

// ── WebSocket connection ───────────────────────────────────────────────────────
async function connectToStreamer(username, attempt = 0) {
  streamerInfo.set(username, { status: 'connecting' });
  teardown(username);

  const info = await fetchStreamerInfo(username);

  if (info.error === 'not_found') {
    streamerInfo.set(username, { status: 'not_found' });
    return; // don't retry — streamer doesn't exist
  }

  if (info.error === 'not_live' || info.error === 'no_next_data') {
    streamerInfo.set(username, { status: 'offline' });
    schedulePoll(username);
    return;
  }

  if (info.error) {
    streamerInfo.set(username, { status: 'error' });
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    const id = setTimeout(() => connectToStreamer(username, attempt + 1), delay);
    wsConns.set(username, { ws: null, heartbeatId: null, reconnectId: id, seenProducts: new Set() });
    return;
  }

  const { livestreamId, sessionExtensionToken, csrfToken } = info;

  // Build WebSocket URL with the user's own auth tokens
  const params = new URLSearchParams({ vsn: '2.0.0', client_type: 'web', client_layer: 'nextjs' });
  if (csrfToken)              params.set('_csrf_token', csrfToken);
  if (sessionExtensionToken)  params.set('sessionExtensionToken', sessionExtensionToken);

  let ws;
  try {
    ws = new WebSocket(`wss://www.whatnot.com/services/live/socket/websocket?${params}`);
  } catch {
    streamerInfo.set(username, { status: 'error' });
    schedulePoll(username);
    return;
  }

  const seenProducts = wsConns.get(username)?.seenProducts ?? new Set();
  const conn = { ws, heartbeatId: null, reconnectId: null, seenProducts };
  wsConns.set(username, conn);

  let ref = 1;
  const nextRef = () => String(ref++);

  ws.onopen = () => {
    streamerInfo.set(username, { status: 'live', livestreamId });

    // Join the auction channel for this stream
    const joinRef = nextRef();
    ws.send(JSON.stringify([joinRef, nextRef(), `auction:${livestreamId}`, 'phx_join', {}]));

    // Ask for recent activity so we catch a giveaway already in progress
    ws.send(JSON.stringify([null, nextRef(), `auction:${livestreamId}`, 'get_latest_live_activity_events', {}]));

    // Keep the connection alive with a heartbeat
    conn.heartbeatId = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify([null, nextRef(), 'phoenix', 'heartbeat', {}]));
      }
    }, HEARTBEAT_MS);
  };

  ws.onmessage = ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!Array.isArray(msg) || msg.length < 5) return;

    const [, , , eventName, payload] = msg;

    // ── Giveaway is running (fires repeatedly while active) ──
    if (eventName === 'giveaway_entry_count_updated') {
      const productId = payload?.productId;
      if (!productId || seenProducts.has(productId)) return;
      seenProducts.add(productId);
      startGiveaway(username, productId, Date.now());
    }

    // ── Channel join reply: check if a giveaway is already in progress ──
    if (eventName === 'phx_reply' && payload?.status === 'ok') {
      const events = payload?.response?.latestLiveActivityEvents;
      if (Array.isArray(events)) checkHistory(username, events, seenProducts);
    }

    // ── Giveaway ended early (winner picked) ──
    if (eventName === 'auction_won' || eventName === 'giveaway_ended') {
      giveaways.delete(username);
      chrome.alarms.clear(`ga_end_${username}`);
    }
  };

  ws.onerror = () => {
    streamerInfo.set(username, { status: 'error' });
  };

  ws.onclose = () => {
    clearInterval(conn.heartbeatId);
    if (!streamerInfo.has(username)) return; // intentionally removed
    streamerInfo.set(username, { status: 'reconnecting' });
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    conn.reconnectId = setTimeout(() => connectToStreamer(username, attempt + 1), delay);
  };
}

// Check recent event history for a giveaway that started within the last 5 minutes
function checkHistory(username, events, seenProducts) {
  const now = Date.now();
  let pendingStart = null;

  // Events are newest-first
  for (const evt of events) {
    const { eventName, timestamp, eventSpecificInfo } = evt;
    if (!eventName || !timestamp) continue;

    if (['GIVEAWAY_STARTED', 'AUCTION_STARTED', 'GIVEAWAY_START'].includes(eventName)) {
      const elapsed = now - timestamp;
      if (elapsed < GIVEAWAY_MS && !pendingStart) {
        pendingStart = { timestamp, productId: eventSpecificInfo?.productId };
      }
    }
    // If we see a win after the start, the giveaway is already over
    if (eventName === 'AUCTION_WON' && pendingStart && timestamp > pendingStart.timestamp) {
      pendingStart = null;
    }
  }

  if (pendingStart?.productId && !seenProducts.has(pendingStart.productId)) {
    seenProducts.add(pendingStart.productId);
    startGiveaway(username, pendingStart.productId, pendingStart.timestamp);
  }
}

// ── Giveaway lifecycle ─────────────────────────────────────────────────────────
function startGiveaway(username, productId, startTime) {
  giveaways.set(username, { startTime, productId });
  chrome.alarms.clear(`ga_end_${username}`);
  const remainingMs = GIVEAWAY_MS - (Date.now() - startTime);
  if (remainingMs > 0) {
    chrome.alarms.create(`ga_end_${username}`, { delayInMinutes: remainingMs / 60_000 });
  }
}

// ── Polling for offline streamers ─────────────────────────────────────────────
function schedulePoll(username) {
  chrome.alarms.clear(`poll_${username}`);
  chrome.alarms.create(`poll_${username}`, { delayInMinutes: POLL_OFFLINE_MS / 60_000 });
}

// ── State snapshot for popup ───────────────────────────────────────────────────
function buildState() {
  const now = Date.now();

  const streamersOut = {};
  for (const [u, info] of streamerInfo) {
    streamersOut[u] = { ...info };
  }

  const giveawaysOut = {};
  for (const [u, g] of giveaways) {
    const remaining = GIVEAWAY_MS - (now - g.startTime);
    if (remaining > 0) giveawaysOut[u] = { ...g, remaining };
    else giveaways.delete(u); // expired; clean up
  }

  return { streamers: streamersOut, giveaways: giveawaysOut };
}
