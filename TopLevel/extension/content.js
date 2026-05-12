// Whatnot Giveaway Tracker -- polling content script.
//
// Runs on any whatnot.com tab (just keep one open -- the home page is fine).
// Periodically fetches the list of tracked streamers from the local tracker,
// then polls Whatnot's API per streamer to detect newly pinned giveaways.
//
// All endpoint specifics live in config.js -- edit that file, not this one.

(() => {
  const cfg = window.WhatnotConfig;
  if (!cfg) {
    console.error("[whatnot-tracker] config.js did not load");
    return;
  }

  const LOG = "[whatnot-tracker]";
  const seenGiveaways = new Map();      // streamer -> last giveaway id
  let trackedStreamers = [];
  let configWarned = false;

  async function refreshStreamers() {
    try {
      const r = await fetch(`${cfg.TRACKER_URL}/streamers`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      trackedStreamers = Array.isArray(j.streamers) ? j.streamers : [];
    } catch (e) {
      // Tracker app probably not running.
      console.debug(LOG, "could not reach tracker:", e.message);
      trackedStreamers = [];
    }
  }

  async function pollStreamer(streamer) {
    const req = cfg.buildRequest(streamer);
    if (!req) {
      if (!configWarned) {
        console.warn(
          LOG,
          "config.js buildRequest() returns null -- edit config.js with Whatnot's endpoint (see extension README)."
        );
        configWarned = true;
      }
      return;
    }
    let json;
    try {
      const r = await fetch(req.url, req.init || {});
      if (!r.ok) {
        console.debug(LOG, `fetch ${streamer} -> HTTP ${r.status}`);
        return;
      }
      json = await r.json();
    } catch (e) {
      console.debug(LOG, `fetch ${streamer} failed:`, e.message);
      return;
    }

    let id;
    try {
      id = cfg.extractGiveawayId(json);
    } catch (e) {
      console.warn(LOG, `extractGiveawayId threw for ${streamer}:`, e);
      return;
    }
    if (id == null) {
      // No active pin; clear so the next pin (even with the same id) is reported.
      seenGiveaways.delete(streamer);
      return;
    }
    const idStr = String(id);
    if (seenGiveaways.get(streamer) === idStr) return;
    seenGiveaways.set(streamer, idStr);

    try {
      const r = await fetch(`${cfg.TRACKER_URL}/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          streamer,
          ts: Date.now(),
          fingerprint: idStr,
        }),
      });
      console.debug(LOG, `pin sent ${streamer}=${idStr} -> ${r.status}`);
    } catch (e) {
      console.warn(LOG, "could not POST /pin:", e.message);
    }
  }

  async function pollAll() {
    if (trackedStreamers.length === 0) return;
    // Sequential to avoid hammering Whatnot's API; each call is small.
    for (const s of trackedStreamers) {
      await pollStreamer(s);
    }
  }

  console.log(LOG, "started; tracker =", cfg.TRACKER_URL);
  refreshStreamers();
  setInterval(refreshStreamers, cfg.STREAMERS_REFRESH_MS);
  setInterval(pollAll, cfg.POLL_INTERVAL_MS);
})();
