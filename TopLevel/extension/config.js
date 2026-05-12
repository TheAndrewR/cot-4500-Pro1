// ============================================================================
// USER CONFIG -- edit this file once after finding Whatnot's pinned-giveaway
// endpoint in devtools. See README.md ("Finding the endpoint") for the
// walk-through.
//
// Until buildRequest() returns a non-null value, the extension is inert (it
// will log a warning to the console of whatever whatnot.com tab you have
// open). The Tk app still works manually.
// ============================================================================

window.WhatnotConfig = {
  // How often to poll each streamer (ms). 10s is a reasonable default --
  // giveaways last 5 minutes so this gives ~4:50 of useful countdown.
  POLL_INTERVAL_MS: 10000,

  // How often to refresh the streamer list from the local tracker (ms).
  STREAMERS_REFRESH_MS: 5000,

  // Local tracker URL.
  TRACKER_URL: "http://127.0.0.1:7755",

  // Build the fetch Request for one streamer. Return either:
  //   - null  -> extension stays inert (default)
  //   - { url, init }  -> passed straight to fetch()
  //
  // The fetch runs from a whatnot.com origin so cookies for that domain are
  // sent automatically (credentials: "include"). Use that to call any
  // authenticated endpoint without dealing with tokens.
  //
  // Example (REST):
  //   buildRequest(streamer) {
  //     return {
  //       url: `https://www.whatnot.com/api/livestreams/${encodeURIComponent(streamer)}/state`,
  //       init: { credentials: "include" },
  //     };
  //   }
  //
  // Example (GraphQL):
  //   buildRequest(streamer) {
  //     return {
  //       url: "https://www.whatnot.com/graphql",
  //       init: {
  //         method: "POST",
  //         credentials: "include",
  //         headers: { "Content-Type": "application/json" },
  //         body: JSON.stringify({
  //           operationName: "LiveStreamPinnedGiveaway",
  //           variables: { username: streamer },
  //           query: "query LiveStreamPinnedGiveaway($username: String!) { ... }",
  //         }),
  //       },
  //     };
  //   }
  buildRequest(_streamer) {
    return null;
  },

  // Given the JSON response from buildRequest(), return a stable identifier
  // for the currently pinned giveaway, or null if none is pinned. The id can
  // be anything string-y -- the tracker only cares that it changes when a
  // new giveaway is pinned.
  //
  // Examples:
  //   return json?.pinnedGiveaway?.id ?? null;
  //   return json?.data?.liveStream?.pinnedGiveaway?.id ?? null;
  extractGiveawayId(_json) {
    return null;
  },
};
