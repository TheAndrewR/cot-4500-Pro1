# Whatnot Giveaway Tracker — Browser Extension

Polls Whatnot's API from a single open tab to detect when each tracked
streamer pins a giveaway, then forwards the event to the local tracker app
(`TopLevel/src/main/whatnot_tracker.py`) on `http://127.0.0.1:7755`.

You only need ONE Whatnot tab open (the home page works fine). The extension
does NOT need to be on each streamer's live page.

> **Caveat:** This depends on Whatnot exposing pinned-giveaway state via a
> pollable HTTP endpoint. If the data is delivered only over WebSocket, this
> approach will not work and you'll need the background-tabs alternative
> instead. The first step below tells you which it is.

> **ToS note:** This polls Whatnot's internal (undocumented) API using your
> logged-in cookies. That may violate their Terms of Service. Use at your own
> risk; keep `POLL_INTERVAL_MS` reasonable (default 10s).

## Install

1. Start the tracker: `python3 TopLevel/src/main/whatnot_tracker.py`
   (Tk window should say *Listening on 127.0.0.1:7755*).
2. Open `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and pick this `TopLevel/extension` folder.
3. Open `https://www.whatnot.com/` in a tab and leave it open. That tab is
   where the polling runs.

Until you complete the configuration below, the extension is inert -- it just
logs a warning and exits. The Tk app's manual buttons still work.

## Finding the endpoint (one-time configuration)

The extension doesn't know Whatnot's endpoint -- you have to discover it once.

1. Log in to Whatnot.
2. Open a live stream that you can see has a **pinned giveaway** banner.
3. Open **DevTools → Network**. Filter by `Fetch/XHR`. Reload the page.
4. Look for a request that returns the giveaway info. Candidates:
   - Anything with `giveaway` in the URL or response body.
   - A GraphQL POST to `/graphql` with an operationName like
     `LiveStream`, `LivePageData`, `PinnedGiveaway`, etc.
   - A REST GET like `/api/livestreams/<slug>/...` or `/api/users/<slug>/live`.
5. Click the request → **Response** tab. Find the field that uniquely
   identifies the pinned giveaway (an `id`, `giveawayId`, etc.). Confirm it
   changes when a different giveaway is pinned.
6. If the only thing transporting giveaway data is a `wss://` WebSocket and
   no HTTP endpoint returns the same info: **stop**. Polling won't work; we'll
   need the background-tabs approach instead.

Once you have a URL and a response shape, edit `config.js`:

- `buildRequest(streamer)` — return `{ url, init }` describing the fetch.
- `extractGiveawayId(json)` — return the id field, or `null` if none.

Reload the extension after editing (`chrome://extensions` → reload button on
the extension card).

## Verifying it works

1. Add a streamer in the Tk app.
2. Switch to your Whatnot home-page tab and open its DevTools console.
3. You should see `[whatnot-tracker] started; tracker = ...` and, every
   10 seconds, debug lines like `pin sent <streamer>=<id> -> 200` once a
   giveaway gets pinned. If you see *"buildRequest() returns null"*, config
   isn't applied yet.
4. The Tk app will start a 5:00 countdown for that streamer and bubble them
   toward the top of the list as the timer drops.

## Endpoints used by the tracker

- `GET  http://127.0.0.1:7755/streamers` → `{"streamers": [...]}`
- `POST http://127.0.0.1:7755/pin`       → `{"streamer", "ts", "fingerprint"}`

CORS is open (`Access-Control-Allow-Origin: *`) so the extension can reach
both from a `whatnot.com` content script.
