# Whatnot Giveaway Tracker — Browser Extension

No configuration needed. The endpoint and query are already filled in based on
Whatnot's LiveShopFeed GraphQL API.

## How to install

1. Start the tracker: `python3 TopLevel/src/main/whatnot_tracker.py`
   The window should say *Listening on 127.0.0.1:7755*.
2. Open `chrome://extensions`, enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this `TopLevel/extension` folder.
4. Open **any** `https://www.whatnot.com/` tab and leave it open — the home
   page is fine. The extension runs its polling loop inside that tab.

## How to use

1. In the Tk app, type a Whatnot **username** (e.g. `cardboard47`) and click Add.
2. The extension fetches that streamer's live page every 10 seconds to check
   the current giveaway section. When a new giveaway listing appears, it
   sends a pin event to the tracker and a 5:00 countdown starts.
3. The countdown is adjusted for how long the giveaway has already been
   running, so if you add a streamer mid-giveaway you'll see ~3:00 remaining
   instead of the full 5:00.
4. The list auto-sorts so the soonest-ending giveaway is always on top.
5. Expired timers stay on the list so you keep tracking the next pin.

## Debugging

Open DevTools on your Whatnot tab → Console. You'll see:

```
[whatnot-tracker] started, session: <uuid>
[whatnot-tracker] cardboard47 -> a61ba099-... (Next.js data)
[whatnot-tracker] NEW pin: cardboard47 giveaway=TGlzdGluZ... updatedAt=1778564701430
```

If you see `"could not find liveId for ..."`:
- The streamer may not be live yet (the extension will keep retrying every 10 min).
- Or Whatnot changed their page structure. In that case, open DevTools → Network
  on the live page, find a POST to `/graphql` with `operationName: "LiveShopFeed"`,
  copy the `liveId` UUID from its variables, and paste it into the tracker manually
  via the Pin button as a workaround.

## Architecture

```
[whatnot.com tab]
  content.js
    ├── every 5s:  GET  http://127.0.0.1:7755/streamers  → list of usernames
    └── every 10s: per streamer:
          1. fetch https://www.whatnot.com/live/<username>  → extract liveId UUID
          2. POST  https://www.whatnot.com/graphql  LiveShopFeed query
          3. if new giveaway in SHOP_GIVEAWAYS section:
               POST http://127.0.0.1:7755/pin  { streamer, fingerprint, startedAt }

[Tk app]
  HTTP server on 127.0.0.1:7755
    GET  /streamers  → JSON list of tracked usernames
    POST /pin        → starts/updates countdown for that streamer
```
