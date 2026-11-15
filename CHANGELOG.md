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
- Node.js 22 or later is required (`engines`), the versions CI tests; Node 20
  reached its end of life in April 2026.
- The plugin has its own icon, a lighthouse.
- The History API client keeps only what replay needs, with its own settings
  (`historyServerUrl`, `historyApiKey`, `historyProvider`,
  `historyTimeoutMs`) and environment variables
  (`SIGNALK_WATCHKEEPER_HISTORY_URL`, `SIGNALK_WATCHKEEPER_HISTORY_API_KEY`,
  `SIGNALK_WATCHKEEPER_HISTORY_TIMEOUT_MS`).
- A baseline learned under signalk-ai-bridge is not carried over: this plugin
  has its own data directory, so it learns afresh once. Stored watch rules
  can be copied over with `POST /watch/rules/save`.
