# Changelog

All notable changes to `signalk-watchkeeper` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project uses [semantic versioning](https://semver.org/).

## [0.1.0]

First release as its own plugin. Watchkeeper was developed inside
`signalk-ai-bridge` and moved here unchanged in what it detects; what changed in
the move is listed under **Changed**.

### Added

- **A background watch of every Signal K path, with no language model.** Off
  by default (`watchEnabled`). It subscribes to every self-vessel path, learns
  each one's normal behaviour, and raises Signal K notifications for:
  - sustained steps and ramps away from the baseline;
  - sensors that stop updating or freeze, and a data feed that goes silent;
  - discrete values never seen before;
  - pumps cycling unusually often;
  - tanks, batteries and zoned values trending toward their limits;
  - GNSS positions that dead reckoning, a second receiver or the fix's own
    quality do not corroborate;
  - redundant sources that disagree, and failover between them.
- **Operating states.** When an engine starts or a charger changes mode, the
  affected paths re-learn, or restore the baseline they had in that state,
  instead of alerting.
- **Incidents.** Related findings are grouped, earliest sign first, with text
  from templates, so every number in it is a measured one.
- **Your own watches.** Rules written in plain words, read by a built-in
  parser and read back before they are stored; numeric comparisons with a
  duration, on/off and other states, changes, and one "while" condition.
- **Feedback, mutes and a watch report.** "Not useful" raises a path's bar;
  mutes silence a path for a while; the report says what the watch saw.
- **Replay.** A fresh watch over recorded History API data, saying what it
  would have raised, to judge sensitivity before it interrupts anyone.
- **The learned baseline survives restarts** (`watch-state.json` in the
  plugin's data directory).
- **A panel** in the admin UI: findings and incidents with sparklines, rules,
  mutes, feedback, the inventory of watched paths, "most unusual now", the
  report and replay.

### Fixed (from CodeRabbit's review of the import)

- An operating state on a path the watch does not baseline (excluded, or
  past the cap on watched paths) is read from the source seen first too: a
  second source's first sample no longer takes over as its primary. That
  source keeps its sample count and interval, so a failover from a source
  that had sent alone for long is reported, and one that reports every 30 s
  keeps its place when a faster source appears. Other paths past the cap
  are not compared across sources, and take no room in the tables kept for
  skipped paths.
- Every request's error reply body is waited for at most 2 s by the fetch
  wrapper itself, also with no timeout set and when fetch ignores the
  abort, and such a body ends as a timeout rather than as an empty reply.
  An error body nobody reads releases the caller's abort listener when its
  2 s are up, and a long body is read in constant memory.
- A rule add redone after a restart that left no room, then one that did,
  is answered as stored, not "already 50 watches"; and a save the plugin
  was stopped during says what is stored (the change, or the options it
  restarted with).
- Error text keeps the host that failed when a URL is followed by a quote,
  a bracket or a backslash and a later `@`, and an `@` after `//` inside a
  path is kept.
- The manual copy box selects its text again on the tap that follows focus
  (iOS).
- "Not above 95 °C", "not below 12 V" and "does not exceed" are read as
  their opposite (`atMost`, `atLeast`), in a rule and in its guard; "not
  above" was stored as `above`. A limit said with "should not", "must not",
  "may not" and the other modal forms keeps its comparison, like "never" and
  "shouldn't" ("should not exceed 14 V" is `above` 14, not `atMost`); "no
  higher than" is `atMost` and "no lower than" `atLeast` (they were `above`
  and `below`); and a comparison negated twice is refused.
- An operating state (engine running, charger mode) is read from its path's
  primary source only: a second source reporting another value no longer
  flips it on every sample and keeps the paths it gates relearning.
- A sensor whose gaps grew before it went silent for good is still reported
  (after an hour's silence, or 1.5 times its longest gap): unconfirmed long
  gaps no longer end its watch. Its regular interval is updated by regular
  gaps only, so random gaps of 2 to 40 minutes no longer raise it until a
  dead sensor goes unreported. Such a path no longer counts toward the data
  feed's steady paths while it reports, so a gateway that goes down with
  regular and raised paths behind it is reported as one silent feed at once,
  not as separate dropouts an hour later.
- A rule whose value or guard is edited waits its full duration again, like
  one moved to another path; a "changes" rule whose guard or value is edited
  does not report the change it already reported again.
- A "changes" rule whose value went stale does not report the same change
  again when the value comes back.
- A model's answer with an incomplete guard is refused instead of becoming a
  rule without one.
- An incident kept active by one open finding keeps at most 50 findings: a
  neighbour that clears and recurs no longer grows it without end. Its title
  still counts the findings dropped (*+120 related*, not *+49*).
- A malformed metadata entry, or a bad value on the stream bus, is recorded
  as an error instead of costing the rest of the delta.
- Replay releases the body of a request it could not read, and an error
  reply whose body stalls no longer holds the replay for good (its body is
  waited for 2 s).
- The panel ignores a status poll that answers after a newer one.
- CI runs the smoke test on the built panel too.

### Changed (in the move from signalk-ai-bridge)

- The plugin id is `signalk-watchkeeper`, and routes are under
  `/plugins/signalk-watchkeeper/watch/...`.
- Notifications are published under `notifications.watchkeeper.*` (they were
  under `notifications.aiBridge.watch.*`).
- Reading a rule the parser cannot uses the plugin's own Ollama settings:
  `ollamaUrl` and `ruleAssistModel` (blank is the parser only). The model is
  let go two minutes after use. `watchRuleAssist` and `watchHelperModel` are
  gone.
- "Ask AI about this" and the other hand-offs to a model are now copy
  buttons: **Copy as text** on an incident and on the "most unusual" list,
  and **Copy for the log** on the report. They copy plain text, also over
  plain HTTP (where browsers offer no clipboard API), and show the text to
  copy by hand when the browser allows neither way.
- A rule-reading `ollamaUrl` that is not an http or https URL, has no scheme,
  or carries a user name, password, query or fragment is refused, and the
  compile answer says why; it is no longer quietly replaced by
  `http://localhost:11434`. A model that cannot be reached is named with its
  cause (`fetch failed: ECONNREFUSED`), without credentials the error quoted.
- Every History API request of a replay, the path listing included, waits
  `historyTimeoutMs` but at least 30 s; a setting of 0 no longer lets a
  listing that never answers keep the replay busy for good.
- Node.js 22.12 or later is required (`engines`), the oldest Node 22 the
  panel's build tooling (`@module-federation/vite`) accepts; Node 20 reached
  its end of life in April 2026. CI tests on Node 24 and 26.
- The plugin has its own icon, a lighthouse.
- The History API client keeps only what replay needs, with its own settings
  (`historyServerUrl`, `historyApiKey`, `historyProvider`,
  `historyTimeoutMs`) and environment variables
  (`SIGNALK_WATCHKEEPER_HISTORY_URL`, `SIGNALK_WATCHKEEPER_HISTORY_API_KEY`,
  `SIGNALK_WATCHKEEPER_HISTORY_TIMEOUT_MS`).
- A baseline learned under signalk-ai-bridge is not carried over: this plugin
  has its own data directory, so it learns afresh once. Stored watch rules
  can be copied over with `POST /watch/rules/save`.
