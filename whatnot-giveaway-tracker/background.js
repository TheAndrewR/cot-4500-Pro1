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
  const UUID_PAT = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const UUID_G   = new RegExp(UUID_PAT, 'gi');

  // ── Method A: Try Whatnot's JSON API endpoints ────────────────────────────────
  // These are the most reliable — no HTML scraping needed.
  const apiEndpoints = [
    `https://www.whatnot.com/api/live/v1/users/${encodeURIComponent(username)}/livestream`,
    `https://www.whatnot.com/api/v2/users/${encodeURIComponent(username)}/current_livestream`,
    `https://www.whatnot.com/api/v2/users/${encodeURIComponent(username)}/active_livestream`,
  ];

  for (const apiUrl of apiEndpoints) {
    try {
      const resp = await fetch(apiUrl, { credentials: 'include', headers: { Accept: 'application/json' } });
      console.log(`[GiveawayTracker] ${username}: API ${apiUrl} → ${resp.status}`);
      if (resp.ok) {
        const ct = resp.headers.get('content-type') ?? '';
        if (ct.includes('json')) {
          const data = await resp.json().catch(() => null);
          if (data) {
            const id = pickBestUUID(data);
            if (id) {
              console.log(`[GiveawayTracker] ${username}: found via API`);
              // Still need auth tokens from the HTML page
              const tokens = await fetchAuthTokens(username);
              return { livestreamId: id, ...tokens };
            }
          }
        }
      }
    } catch (e) {
      console.log(`[GiveawayTracker] ${username}: API error —`, e.message);
    }
  }

  // ── Fetch profile page HTML ───────────────────────────────────────────────────
  // Try @username first — that's Whatnot's canonical profile URL format.
  const urlsToTry = [
    `https://www.whatnot.com/@${username}`,
    `https://www.whatnot.com/user/${username}`,
    `https://www.whatnot.com/live/${username}`,
  ];

  let html = null;
  let finalUrl = null;
  for (const url of urlsToTry) {
    try {
      const resp = await fetch(url, { credentials: 'include' });
      console.log(`[GiveawayTracker] ${username}: GET ${url} → ${resp.status} (landed: ${resp.url})`);
      if (resp.ok) { html = await resp.text(); finalUrl = resp.url; break; }
      if (resp.status === 404) continue;
    } catch (e) {
      console.log(`[GiveawayTracker] ${username}: fetch error —`, e.message);
    }
  }

  if (!html) return { error: 'not_found' };

  // ── Method B: UUID in the final URL (redirect to a live-stream URL) ───────────
  let livestreamId = null;
  const urlUuidMatch = finalUrl?.match(new RegExp(`/(${UUID_PAT})`, 'i'));
  if (urlUuidMatch) {
    livestreamId = urlUuidMatch[1];
    console.log(`[GiveawayTracker] ${username}: found via redirect URL (${finalUrl})`);
  }

  // ── Method C: "auction:<uuid>" anywhere in the raw HTML ──────────────────────
  if (!livestreamId) {
    const m = html.match(new RegExp(`auction[:\\\\/"']+?(${UUID_PAT})`, 'i'));
    if (m) { livestreamId = m[1]; console.log(`[GiveawayTracker] ${username}: found via auction: pattern`); }
  }

  // ── Method D: known key names in raw HTML (JSON or JS object literals) ────────
  if (!livestreamId) {
    const m = html.match(
      new RegExp(
        `["'](?:livestreamId|livestream_id|auctionId|auction_id|streamId|stream_id|liveId|live_id)["']\\s*[=:]\\s*["']?(${UUID_PAT})["']?`,
        'i'
      )
    );
    if (m) { livestreamId = m[1]; console.log(`[GiveawayTracker] ${username}: found via key-value pattern`); }
  }

  // ── Method E: parse __NEXT_DATA__ and walk the full tree ─────────────────────
  if (!livestreamId) {
    const ndMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/);
    if (ndMatch) {
      try {
        const nd = JSON.parse(ndMatch[1]);
        livestreamId = pickBestUUID(nd);
        if (livestreamId) console.log(`[GiveawayTracker] ${username}: found via __NEXT_DATA__`);
        else console.log(`[GiveawayTracker] ${username}: __NEXT_DATA__ has no suitable UUID —`, ndMatch[1].slice(0, 600));
      } catch (e) {
        console.log(`[GiveawayTracker] ${username}: __NEXT_DATA__ parse error —`, e.message);
      }
    } else {
      console.log(`[GiveawayTracker] ${username}: no __NEXT_DATA__ tag — HTML snippet:`, html.slice(0, 800));
    }
  }

  console.log(`[GiveawayTracker] ${username}: livestreamId = ${livestreamId ?? 'NOT FOUND'}`);
  if (!livestreamId) return { error: 'not_live' };

  // ── Auth tokens ───────────────────────────────────────────────────────────────
  const csrfMeta  = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/);
  const csrfJson  = html.match(/["']_csrf_token["']\s*:\s*["']([^"']{20,})["']/);
  const csrfToken = csrfMeta?.[1] ?? csrfJson?.[1] ?? null;

  const tokenMatch = html.match(/sessionExtensionToken["':\s]+["']?(SFMyNTY[A-Za-z0-9._-]+)/);
  const sessionExtensionToken = tokenMatch?.[1] ?? null;

  console.log(`[GiveawayTracker] ${username}: csrfToken=${csrfToken ? 'found' : 'missing'} sessionToken=${sessionExtensionToken ? 'found' : 'missing'}`);
  return { livestreamId, csrfToken, sessionExtensionToken };
}

// Fetch just the auth tokens from the profile page (used when API gave us the livestream ID)
async function fetchAuthTokens(username) {
  try {
    const resp = await fetch(`https://www.whatnot.com/@${username}`, { credentials: 'include' });
    if (!resp.ok) return { csrfToken: null, sessionExtensionToken: null };
    const html = await resp.text();
    const csrfMeta  = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/);
    const csrfJson  = html.match(/["']_csrf_token["']\s*:\s*["']([^"']{20,})["']/);
    const csrfToken = csrfMeta?.[1] ?? csrfJson?.[1] ?? null;
    const tokenMatch = html.match(/sessionExtensionToken["':\s]+["']?(SFMyNTY[A-Za-z0-9._-]+)/);
    return { csrfToken, sessionExtensionToken: tokenMatch?.[1] ?? null };
  } catch {
    return { csrfToken: null, sessionExtensionToken: null };
  }
}

// Walk a JSON tree and return the best UUID candidate, ranked by key name.
// Collects ALL UUIDs before picking — avoids returning a user-id before the livestream id.
function pickBestUUID(obj) {
  const HIGH = ['auction', 'livestream'];
  const MED  = ['stream', 'live'];
  let high = null, med = null;

  function walk(o, depth) {
    if (depth > 30 || !o || typeof o !== 'object') return;
    for (const [key, val] of Object.entries(o)) {
      const k = key.toLowerCase();
      if (typeof val === 'string' && UUID_RE.test(val)) {
        if (!high && HIGH.some(h => k.includes(h))) { high = val; continue; }
        if (!med  && MED.some(m => k.includes(m)))  { med  = val; continue; }
      }
      if (Array.isArray(val)) val.forEach(item => walk(item, depth + 1));
      else if (val && typeof val === 'object') walk(val, depth + 1);
    }
  }

  walk(obj, 0);
  return high ?? med ?? null;
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
