// Whatnot Giveaway Tracker — polling content script.
//
// Runs on any open whatnot.com tab. No configuration needed.
//
// Every 10 seconds, for each streamer you've added to the Tk tracker:
//   1. Resolve their username to a livestream UUID (liveId) by fetching their
//      live page and reading the Next.js page data or finding the UUID in the HTML.
//   2. Call Whatnot's LiveShopFeed GraphQL query to get the current giveaway section.
//   3. When a new giveaway listing ID appears, POST a pin event to the local tracker.
//      The event includes updatedAtMs so the countdown reflects how long the
//      giveaway has already been running.

(() => {
  const TRACKER_URL = "http://127.0.0.1:7755";
  const GQL_URL = "https://www.whatnot.com/graphql";
  const POLL_INTERVAL_MS = 10000;
  const STREAMER_REFRESH_MS = 5000;
  const LIVEID_TTL_MS = 10 * 60 * 1000;

  // Unique session ID for Whatnot's analytics (required by the query).
  const SESSION_ID = crypto.randomUUID();

  // Minimal query — only asks for the fields we need from the shop feed.
  // Uses the exact operationName and @attribution the Whatnot web app sends.
  const QUERY = `query LiveShopFeed($liveId:ID!$first:Int$sessionId:ID)@attribution(owner:"selling-platform" feature:"live-shop"){liveShop(liveId:$liveId){feed(sessionId:$sessionId){objects(first:$first){edges{node{...on Section{id sectionType contents{edges{node{...on ListingNode{id transactionType updatedAtMs}...on GiveawayNode{id}}}}}}}}}}}`;

  // username -> { liveId: string|null, cachedAt: number }
  const liveIdCache = new Map();
  // username -> Set<string>  (listing IDs we've already fired a pin for)
  const seenGiveaways = new Map();

  let trackedStreamers = [];

  // ── liveId resolution ──────────────────────────────────────────────────────
  // Whatnot's GraphQL queries use an internal UUID (liveId) for each stream,
  // not the streamer's username. We get it by fetching the live page HTML and
  // looking for the UUID in two places:
  //   1. The __NEXT_DATA__ JSON block (Next.js server-side props).
  //   2. A regex for UUIDs following common key names like "liveId", "channelId".

  async function resolveUsernameToLiveId(username) {
    try {
      const res = await fetch(
        `https://www.whatnot.com/live/${encodeURIComponent(username)}`,
        { credentials: "include", headers: { Accept: "text/html" } }
      );
      if (!res.ok) {
        console.debug(`[whatnot-tracker] ${username}: HTTP ${res.status} (not live?)`);
        return null;
      }
      const html = await res.text();

      // Attempt 1: __NEXT_DATA__ JSON blob.
      const ndMatch = html.match(
        /<script id="__NEXT_DATA__" type="application\/json">([^<]+)<\/script>/
      );
      if (ndMatch) {
        try {
          const nd = JSON.parse(ndMatch[1]);
          const pp = nd?.props?.pageProps;
          const id =
            pp?.liveStream?.id ??
            pp?.livestream?.id ??
            pp?.live?.id ??
            pp?.liveId ??
            nd?.query?.liveId;
          if (id && /^[0-9a-f-]{36}$/i.test(id)) {
            console.debug(`[whatnot-tracker] ${username} -> ${id} (Next.js data)`);
            return id;
          }
        } catch (_) {}
      }

      // Attempt 2: UUID immediately after a known key name in the raw HTML/JS.
      const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const keyMatch = html.match(
        new RegExp(
          `(?:liveId|livestream_id|channelId|live_id|stream_id)["']?\\s*[:=]\\s*["']?(${UUID_RE.source})`,
          "i"
        )
      );
      if (keyMatch) {
        console.debug(`[whatnot-tracker] ${username} -> ${keyMatch[1]} (regex)`);
        return keyMatch[1];
      }

      console.warn(
        `[whatnot-tracker] could not find liveId for "${username}". ` +
          `They may not be live, or Whatnot changed their page structure.`
      );
      return null;
    } catch (e) {
      console.debug(`[whatnot-tracker] resolveUsername(${username}) threw:`, e.message);
      return null;
    }
  }

  async function getCachedLiveId(username) {
    const cached = liveIdCache.get(username);
    if (cached && Date.now() - cached.cachedAt < LIVEID_TTL_MS) {
      return cached.liveId;
    }
    const liveId = await resolveUsernameToLiveId(username);
    const prev = cached?.liveId;
    liveIdCache.set(username, { liveId, cachedAt: Date.now() });
    // If the liveId changed the stream restarted; reset seen giveaways.
    if (prev && liveId !== prev) {
      seenGiveaways.delete(username);
    }
    return liveId;
  }

  // ── GraphQL polling ────────────────────────────────────────────────────────

  async function fetchShopGiveaways(liveId) {
    try {
      const res = await fetch(GQL_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operationName: "LiveShopFeed",
          variables: { liveId, first: 24, sessionId: SESSION_ID },
          query: QUERY,
        }),
      });
      if (!res.ok) {
        console.debug(`[whatnot-tracker] GraphQL HTTP ${res.status} for liveId ${liveId}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      console.debug("[whatnot-tracker] fetchShopGiveaways threw:", e.message);
      return null;
    }
  }

  // Extract giveaway listings from the SHOP_GIVEAWAYS section.
  // Returns [{ id, updatedAtMs }] for each active giveaway listing.
  function extractGiveaways(json) {
    const edges = json?.data?.liveShop?.feed?.objects?.edges ?? [];
    for (const { node } of edges) {
      if (node?.sectionType !== "SHOP_GIVEAWAYS") continue;
      return (node.contents?.edges ?? []).flatMap(({ node: item }) => {
        if (!item?.id) return [];
        // Accept ListingNodes with transactionType GIVEAWAY, or plain GiveawayNodes.
        if (item.transactionType && item.transactionType !== "GIVEAWAY") return [];
        return [{ id: item.id, updatedAtMs: item.updatedAtMs ?? null }];
      });
    }
    return [];
  }

  // ── per-streamer poll ──────────────────────────────────────────────────────

  async function pollStreamer(username) {
    const liveId = await getCachedLiveId(username);
    if (!liveId) return;

    const json = await fetchShopGiveaways(liveId);
    if (!json) return;

    const giveaways = extractGiveaways(json);
    const seen = seenGiveaways.get(username) ?? new Set();

    for (const { id, updatedAtMs } of giveaways) {
      if (seen.has(id)) continue;
      seen.add(id);

      console.debug(`[whatnot-tracker] NEW pin: ${username} giveaway=${id} updatedAt=${updatedAtMs}`);
      fetch(`${TRACKER_URL}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamer: username,
          ts: Date.now(),
          fingerprint: id,
          startedAt: updatedAtMs, // lets the tracker show correct remaining time
        }),
      }).catch(() => {});
    }

    seenGiveaways.set(username, seen);
  }

  async function pollAll() {
    // Sequential: avoids hammering Whatnot's API with concurrent requests.
    for (const s of trackedStreamers) {
      await pollStreamer(s);
    }
  }

  // ── streamer list sync ─────────────────────────────────────────────────────

  async function refreshStreamers() {
    try {
      const res = await fetch(`${TRACKER_URL}/streamers`, { cache: "no-store" });
      if (!res.ok) return;
      const { streamers } = await res.json();
      const next = Array.isArray(streamers) ? streamers : [];

      // Evict caches for removed streamers.
      for (const name of [...liveIdCache.keys()]) {
        if (!next.includes(name)) {
          liveIdCache.delete(name);
          seenGiveaways.delete(name);
        }
      }
      trackedStreamers = next;
    } catch {
      // Tracker app not running yet — silent.
    }
  }

  // ── startup ────────────────────────────────────────────────────────────────

  console.log("[whatnot-tracker] started, session:", SESSION_ID);
  refreshStreamers().then(() => pollAll());
  setInterval(refreshStreamers, STREAMER_REFRESH_MS);
  setInterval(pollAll, POLL_INTERVAL_MS);
})();
