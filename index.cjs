'use strict';

const { authHeadersFromRequest, normalizeHistoryConfig } = require('./lib/history-service.cjs');
const { SETTING_LABELS, readSettings, settingsSchema, settingsUiSchema } = require('./lib/settings.cjs');
const { createWatchService } = require('./lib/watch-service.cjs');
const { normalizeWatchConfig } = require('./lib/watch/engine.cjs');
const { MAX_RULES, hasValidId, normalizeRules } = require('./lib/watch/rules.cjs');

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

function badRequest(message) {
  const error = new Error(message);
  error.code = 'validation-failed';
  return error;
}

/** A route's JSON body: the parsed body Express left, or the raw stream read and parsed. */
async function readJsonBody(req) {
  if (req && typeof req.body === 'object' && req.body !== null) {
    return req.body;
  }
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    throw badRequest('Request body must be JSON.');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_REQUEST_BODY_BYTES) {
      throw badRequest('Request body is too large.');
    }
    chunks.push(buffer);
  }
  const rawBody = Buffer.concat(chunks).toString('utf8').trim();
  if (rawBody.length === 0) {
    return {};
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    throw badRequest('Request body is not valid JSON.');
  }
}

module.exports = function createPlugin(app, dependencies = {}) {
  // The options as Signal K stored them - sectioned, or flat from before the
  // sections - and as every save writes them back: a save changes its own key
  // (watchRules) and keeps the rest as it is. Read them through readSettings().
  let pluginOptions = {};
  let routesRegistered = false;
  // Express has no public API for unmounting a subrouter, and signalk-server
  // calls registerWithRouter unconditionally - outside its `if (enabled)` guard
  // - so gating a stopped plugin is the plugin's own job.
  let running = false;
  // Bumped on every start/stop, so a save that finishes after a restart can
  // tell its options are no longer the running ones.
  let lifecycleGeneration = 0;
  const watchService = createWatchService(app, { ...dependencies, pluginId: 'signalk-watchkeeper' });

  const getConfig = () => normalizeHistoryConfig(readSettings(pluginOptions));

  // The settings form; lib/settings.cjs holds it, with readSettings(), which
  // turns what the form stores into the flat settings the code below reads.
  const schema = () => settingsSchema();

  /**
   * HTTP status for an error code.
   *
   * One place for code -> HTTP. `fallback` is the status for a code nothing
   * here maps.
   */
  const statusForCode = (code, fallback = 502) => {
    switch (code) {
      case 'validation-failed':
        return 400;
      case 'unauthorized':
        return 401;
      // The request was valid but the stored state it refers to has moved on
      // (a path another save removed, a list that is not stored at all).
      case 'conflict':
        return 409;
      case 'disabled':
        return 503;
      case 'timeout':
        return 504;
      default:
        return fallback;
    }
  };

  /** The error code for a route's error body, from whatever was thrown. */
  const errorCode = (error) =>
    typeof error === 'object' && error !== null && typeof error.code === 'string' ? error.code : 'unknown';

  /** The message for a route's error body; `fallback` when nothing usable was thrown. */
  const errorMessage = (error, fallback) => (error instanceof Error ? error.message : fallback);

  /**
   * Answer a failed route. A thrown error that carries its own HTTP status
   * (a backend's 404, say) keeps it; anything else is mapped from its code.
   */
  const sendError = (res, error, fallbackStatus, fallbackMessage) => {
    const statusCode =
      typeof error === 'object' && error !== null && typeof error.statusCode === 'number'
        ? error.statusCode
        : statusForCode(errorCode(error), fallbackStatus);

    res.status(statusCode).json({
      error: { code: errorCode(error), message: errorMessage(error, fallbackMessage) }
    });
  };

  // A stopped plugin serves nothing. Returns true when the request was
  // answered with 503 and the caller should stop.
  const rejectIfStopped = (res) => {
    if (running) {
      return false;
    }
    res.status(503).json({
      error: { code: 'disabled', message: 'Watchkeeper is stopped.' }
    });
    return true;
  };

  // A save the plugin stopped right after: the change is stored, so the
  // reply says so (and that it need not be made again) instead of the
  // generic "stopped", and sends no stopped plugin's lists.
  const rejectIfStoppedAfterSave = (res, saved) => {
    if (running) {
      return false;
    }
    res.status(503).json({
      error: {
        code: 'disabled',
        message: saved
          ? 'The change was saved, but the plugin stopped before it could reply; reload once it runs again instead of making the change again.'
          : 'Watchkeeper is stopped.'
      }
    });
    return true;
  };

  /**
   * May this request change what the watch does (mute, feedback, rules,
   * replay)?
   *
   * On a server with security enabled that means an authenticated principal
   * with more than read access; on a server with security off - a single-user
   * boat network, which is the common Signal K setup - there is no identity to
   * check and the route is as open as the rest of the server already is.
   */
  const isWriteAllowed = (req) => {
    const strategy = app && app.securityStrategy;
    if (!strategy || (typeof strategy.isDummy === 'function' && strategy.isDummy())) {
      return true;
    }

    const principal = req && req.skPrincipal;
    if (principal) {
      const permissions = String(principal.permissions || '').toLowerCase();
      return permissions === 'admin' || permissions === 'readwrite';
    }

    // Older strategies expose the session only through getLoginStatus.
    if (typeof strategy.getLoginStatus === 'function') {
      try {
        const status = strategy.getLoginStatus(req) || {};
        if (status.status !== 'loggedIn') return false;
        // The login's level is userLevel. readOnlyAccess is the server's
        // "Allow Readonly Access" setting (reads without a login), not this
        // login's, so it says nothing about whether it may write.
        const level = String(status.userLevel || '').toLowerCase();
        return level === 'admin' || level === 'readwrite';
      } catch {
        return false;
      }
    }

    return false;
  };

  // Every write to the stored options goes through this one queue. Each
  // handler used to copy pluginOptions, await the save, then assign its copy
  // back - so two overlapping saves (two watch rules, say) both started from
  // the same options and the later one silently undid the earlier, while both
  // reported success.
  let optionsWriteQueue = Promise.resolve();

  /**
   * Read-modify-save the plugin's options, one at a time. `change` gets the
   * options as they are once every earlier save has finished and returns the
   * new options; they are stored, then applied to the running plugin.
   * Returning the options it was given unchanged (the same object) means
   * "nothing to change": nothing is written, so a no-op neither rewrites the
   * stored settings nor fails on a host that cannot store them.
   */
  const updatePluginOptions = (change) => {
    const run = optionsWriteQueue.then(async () => {
      // A restart while a save is in flight replaces pluginOptions with the
      // options the server started with. The change is then made again on
      // those and saved again, so neither memory nor disk keeps an older copy
      // - and a save queued while the plugin was stopped (pluginOptions is {}
      // then) writes nothing at all instead of storing just its own change.
      // What the last write stored: this change ('change'), the restart's
      // own options put back because the redo had nothing to do ('restart'),
      // or nothing yet.
      let stored;
      const stopped = () => {
        const error = new Error(
          stored === 'change'
            ? 'The change was written, but the plugin stopped before it took effect; if the settings were saved meanwhile (from the admin page, say), they may have replaced it.'
            : stored === 'restart'
              ? 'The plugin stopped; the stored settings are the ones it restarted with (which may or may not hold this change).'
              : 'The plugin is stopped; nothing was saved.'
        );
        error.code = 'disabled';
        error.statusCode = 503;
        return error;
      };
      // Three attempts, then a fourth pass only to report: stopped, or kept
      // restarting.
      for (let attempt = 0; ; attempt += 1) {
        if (!running) throw stopped();
        if (attempt === 3) {
          const error = new Error('The plugin kept restarting while saving; the stored settings may hold this change. Check them and try again.');
          error.code = 'conflict';
          error.statusCode = 409;
          throw error;
        }
        const generation = lifecycleGeneration;
        const updated = change(pluginOptions);
        if (updated === pluginOptions) {
          // Redone after a restart and nothing to change now - but an
          // earlier attempt already stored a copy made from the older
          // options: put the restart's options back on disk.
          if (stored) {
            await new Promise((resolve, reject) => {
              app.savePluginOptions(pluginOptions, (error) => (error ? reject(error) : resolve()));
            });
            stored = 'restart';
            // Restarted again while that was written: start over on the
            // newest options, so disk ends with what the plugin runs.
            if (generation !== lifecycleGeneration) continue;
          }
          return updated;
        }
        if (typeof app.savePluginOptions !== 'function') {
          const error = new Error('This Signal K server does not let plugins store their own settings.');
          error.code = 'unknown';
          error.statusCode = 501;
          throw error;
        }
        await new Promise((resolve, reject) => {
          app.savePluginOptions(updated, (error) => (error ? reject(error) : resolve()));
        });
        stored = 'change';
        if (generation === lifecycleGeneration) {
          pluginOptions = updated;
          return updated;
        }
      }
    });
    // A failed save must not wedge the queue for the next one.
    optionsWriteQueue = run.catch(() => {});
    return run;
  };

  /** GET /watch/status: what the watch has learned and what it has found. */
  const watchStatusHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      res.status(200).json(watchService.status());
    } catch (error) {
      sendError(res, error, 500, 'Unknown watch failure.');
    }
  };

  /** GET /watch/series?path=…: the learned series behind a finding, for the panel's sparkline. */
  const watchSeriesHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      // Express parses the query string; a bare Node request (the preview
      // host, some test harnesses) only has the URL.
      let path = req && req.query && typeof req.query.path === 'string' ? req.query.path : '';
      if (!path && req && typeof req.url === 'string') {
        path = new URL(req.url, 'http://localhost').searchParams.get('path') || '';
      }
      const series = watchService.series(path);
      if (!series) {
        res.status(404).json({ error: { code: 'not-found', message: `The watch has no series for ${path}.` } });
        return;
      }
      res.status(200).json(series);
    } catch (error) {
      sendError(res, error, 500, 'Unknown watch failure.');
    }
  };

  /**
   * GET /watch/inventory: every path the watch has found on this vessel, what
   * it does with each, and which checks this vessel's data supports.
   */
  const watchInventoryHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      res.status(200).json(watchService.inventory());
    } catch (error) {
      sendError(res, error, 500, 'Unknown watch failure.');
    }
  };

  /** GET /watch/unusual: the paths furthest from their own normal right now, alarming or not. */
  const watchUnusualHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      res.status(200).json(watchService.unusual());
    } catch (error) {
      sendError(res, error, 500, 'Unknown watch failure.');
    }
  };

  /** GET /watch/report?hours=24: what the watch saw, as facts and plain lines. */
  const watchReportHandler = async (req, res) => {
    if (rejectIfStopped(res)) {
      return;
    }
    try {
      let hours = req && req.query ? req.query.hours : undefined;
      if (hours === undefined && req && typeof req.url === 'string') {
        hours = new URL(req.url, 'http://localhost').searchParams.get('hours') || undefined;
      }
      res.status(200).json(watchService.report(Number(hours) || 24));
    } catch (error) {
      sendError(res, error, 500, 'Unknown watch failure.');
    }
  };

  const rejectUnlessWriter = (req, res, action) => {
    if (isWriteAllowed(req)) {
      return false;
    }
    res.status(401).json({
      error: { code: 'unauthorized', message: `${action} requires a Signal K login with write access.` }
    });
    return true;
  };

  /** POST /watch/mute { path, minutes } and /watch/unmute { path }. */
  const watchMuteHandler = (unmute) => async (req, res) => {
    if (rejectIfStopped(res) || rejectUnlessWriter(req, res, 'Muting a watched path')) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      const mutes = unmute
        ? watchService.unmute(body && body.path)
        : watchService.mute(body && body.path, body && body.minutes);
      res.status(200).json({ mutes });
    } catch (error) {
      sendError(res, error, 500, 'Unknown watch failure.');
    }
  };

  /**
   * POST /watch/feedback { path, useful }: "not useful" (false) makes the path
   * need a bigger departure before it is reported again; true undoes one
   * dismissal; "reset" forgets them all.
   */
  const watchFeedbackHandler = async (req, res) => {
    if (rejectIfStopped(res) || rejectUnlessWriter(req, res, 'Giving watch feedback')) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      res.status(200).json(watchService.feedback(body && body.path, body && body.useful));
    } catch (error) {
      sendError(res, error, 500, 'Unknown watch failure.');
    }
  };

  /**
   * POST /watch/replay { duration? }: run a fresh watch over recorded history
   * and report what it would have raised. Read-only, but it is the heaviest
   * thing this plugin does, so it is a writer's action.
   */
  const watchReplayHandler = async (req, res) => {
    if (rejectIfStopped(res) || rejectUnlessWriter(req, res, 'Replaying history through the watch')) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      const result = await watchService.replay(body || {}, getConfig(), { authHeaders: authHeadersFromRequest(req) });
      res.status(200).json(result);
    } catch (error) {
      if (errorCode(error) === 'busy') {
        res.status(409).json({ error: { code: 'busy', message: errorMessage(error, 'Busy.') } });
        return;
      }
      sendError(res, error, 500, 'Unknown replay failure.');
    }
  };

  /** POST /watch/rules/compile { text, path? }: read a request back as a rule, without storing it. */
  const watchRuleCompileHandler = async (req, res) => {
    if (rejectIfStopped(res) || rejectUnlessWriter(req, res, 'Writing a watch rule')) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      res.status(200).json(await watchService.compileRule(body || {}));
    } catch (error) {
      sendError(res, error, 500, 'Unknown watch failure.');
    }
  };

  /**
   * Change the stored watch rules. Stored as plugin options, so a restart and a config backup carry them. `change` gets
   * the rules as stored when its turn in the write queue comes, so edits from
   * two panels, or two quick clicks, apply to each other's result instead of
   * one overwriting the other from a stale list.
   */
  // `{ rules, saved }`: the list, and whether the change is stored - written
  // by one of the attempts, and held by the rules stored at the end. A redo
  // after a restart that loaded the options the first attempt wrote finds
  // nothing to do, and the change is still saved; one that found it could
  // not be made (`refused()`: no room left) is not.
  const changeWatchRules = async (change, refused = () => false) => {
    let rules;
    let generation;
    let wrote = false;
    // One moment for every attempt: a rule without `createdAt` is stamped
    // the same each time, so a redo after a restart that loaded the options
    // the first attempt wrote finds the same list, and writes nothing.
    const stamp = Date.now();
    await updatePluginOptions((current) => {
      generation = lifecycleGeneration;
      const before = normalizeRules(current.watchRules, stamp);
      rules = normalizeRules(change(before), stamp);
      // Nothing changed (a refused add, an unknown id, or a redo that finds
      // the change made): write nothing, so a no-op neither rewrites the
      // settings nor fails on a host that cannot store them.
      if (JSON.stringify(rules) === JSON.stringify(before)) {
        return current;
      }
      wrote = true;
      return { ...current, watchRules: rules };
    });
    // Restarted meanwhile: the new start already loaded the stored rules.
    return { rules: generation === lifecycleGeneration ? watchService.setRules(rules) : rules, saved: wrote && !refused() };
  };

  /** POST /watch/rules/add { rule }: add one rule (or replace the one with its id). */
  const watchRuleAddHandler = async (req, res) => {
    if (rejectIfStopped(res) || rejectUnlessWriter(req, res, 'Changing watch rules')) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      const [rule] = normalizeRules([body && body.rule]);
      if (!rule) {
        res.status(400).json({ error: { code: 'validation-failed', message: 'Send one valid rule as "rule".' } });
        return;
      }
      // A rule already stored as it is (re-added unchanged) is not judged
      // again: it was accepted once, and refusing it now would lock it in.
      const unchanged = normalizeRules(pluginOptions.watchRules).some(
        (stored) => stored.id === rule.id && JSON.stringify(stored) === JSON.stringify(rule)
      );
      const problem = unchanged ? undefined : watchService.checkRule(rule);
      if (problem) {
        res.status(400).json({ error: { code: 'validation-failed', message: problem } });
        return;
      }
      let full = false;
      // A rule that came without an id is a new rule: if its derived id is
      // already taken by a different stored rule, it is numbered as a copy
      // rather than replacing that one.
      const fresh = !hasValidId(body.rule);
      // What a rule says, without when it was made or what it is called.
      const content = ({ id, createdAt, ...rest }) => JSON.stringify(rest);
      const base = rule.id;
      const { rules, saved } = await changeWatchRules((current) => {
        // Decided afresh on each attempt: a redo after a restart may find
        // room the first attempt did not.
        full = false;
        // Numbered afresh on each attempt (a save redone after a restart
        // starts again from the derived id).
        if (fresh) {
          rule.id = base;
          for (let copy = 2; current.some((item) => item.id === rule.id && content(item) !== content(rule)); copy += 1) {
            rule.id = `${base.slice(0, 36)}-${copy}`;
          }
        }
        const others = current.filter((item) => item.id !== rule.id);
        // At the cap, the new rule is the one truncation would drop: refuse
        // instead of reporting success for a rule that was never stored.
        if (others.length >= MAX_RULES) {
          full = true;
          return current;
        }
        return [...others, rule];
      }, () => full);
      // Stopped between the save and this reply: no lists from a stopped
      // plugin for the panel to take as the stored ones.
      if (rejectIfStoppedAfterSave(res, saved)) return;
      if (full) {
        res.status(statusForCode('conflict')).json({
          error: { code: 'conflict', message: `There are already ${MAX_RULES} watches; remove one first.` }
        });
        return;
      }
      res.status(200).json({ rules });
    } catch (error) {
      sendError(res, error, 500, 'Could not save the watch rules.');
    }
  };

  /** POST /watch/rules/remove { id }: remove one rule by id. */
  const watchRuleRemoveHandler = async (req, res) => {
    if (rejectIfStopped(res) || rejectUnlessWriter(req, res, 'Changing watch rules')) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      const id = body && typeof body.id === 'string' ? body.id : '';
      if (!id) {
        res.status(400).json({ error: { code: 'validation-failed', message: 'Send the id of the rule to remove.' } });
        return;
      }
      let found = false;
      const { rules, saved } = await changeWatchRules((current) => {
        // Once found, found: a redo after a restart sees the list it wrote.
        found = found || current.some((item) => item.id === id);
        return current.filter((item) => item.id !== id);
      });
      if (rejectIfStoppedAfterSave(res, saved)) return;
      // An id that is not stored (a panel open across an upgrade that changed
      // derived ids, say) is not reported as removed.
      if (!found) {
        res.status(404).json({ error: { code: 'not-found', message: 'No watch with that id is stored; reload the list.' }, rules });
        return;
      }
      res.status(200).json({ rules });
    } catch (error) {
      sendError(res, error, 500, 'Could not save the watch rules.');
    }
  };

  /** POST /watch/rules/save { rules }: replace the whole list, for tools that manage it as a unit. */
  const watchRuleSaveHandler = async (req, res) => {
    if (rejectIfStopped(res) || rejectUnlessWriter(req, res, 'Changing watch rules')) {
      return;
    }
    try {
      const body = await readJsonBody(req);
      if (!body || !Array.isArray(body.rules)) {
        res.status(400).json({ error: { code: 'validation-failed', message: 'Send rules as an array.' } });
        return;
      }
      // Only rules that are new or changed are judged: one stored before the
      // check existed, or whose path is quiet now, must not lock a tool out
      // of saving the rest of the list.
      const stored = new Map(normalizeRules(pluginOptions.watchRules).map((rule) => [rule.id, JSON.stringify(rule)]));
      const problem = normalizeRules(body.rules)
        .filter((rule) => stored.get(rule.id) !== JSON.stringify(rule))
        .map((rule) => watchService.checkRule(rule))
        .find(Boolean);
      if (problem) {
        res.status(400).json({ error: { code: 'validation-failed', message: problem } });
        return;
      }
      const { rules, saved } = await changeWatchRules(() => body.rules);
      if (rejectIfStoppedAfterSave(res, saved)) return;
      res.status(200).json({ rules });
    } catch (error) {
      sendError(res, error, 500, 'Could not save the watch rules.');
    }
  };

  const uiSchema = () => settingsUiSchema();

  return {
    id: 'signalk-watchkeeper',
    name: 'Watchkeeper',
    description: 'A background watch of every Signal K path: learns what is normal and raises notifications when a path departs from it.',
    schema,
    uiSchema,
    start: (options = {}) => {
      pluginOptions = options;
      running = true;
      lifecycleGeneration += 1;
      const settings = readSettings(options);
      watchService.start(settings);
      // A model is named but its server address was refused: say so where the
      // operator looks, not only when a rule fails to read.
      const watch = normalizeWatchConfig(settings);
      const assistProblem =
        watch.ruleAssistModel && watch.ollamaUrlProblem
          ? `Wordings the built-in reader cannot read are not sent to ${watch.ruleAssistModel}: the "${SETTING_LABELS.ollamaUrl}" setting ${watch.ollamaUrlProblem}.`
          : '';
      if (assistProblem && typeof app.error === 'function') {
        app.error(`Watchkeeper: ${assistProblem}`);
      }
      if (typeof app.setPluginStatus === 'function') {
        const state = watch.watchEnabled ? 'Watchkeeper is watching.' : `Watchkeeper is off; switch on "${SETTING_LABELS.watchEnabled}" in its settings.`;
        app.setPluginStatus(assistProblem ? `${state} ${assistProblem}` : state);
      }
    },
    registerWithRouter: (router) => {
      if (routesRegistered) {
        return;
      }
      router.get('/watch/status', watchStatusHandler);
      router.get('/watch/series', watchSeriesHandler);
      router.get('/watch/inventory', watchInventoryHandler);
      router.get('/watch/unusual', watchUnusualHandler);
      router.post('/watch/rules/compile', watchRuleCompileHandler);
      router.post('/watch/rules/save', watchRuleSaveHandler);
      router.post('/watch/rules/add', watchRuleAddHandler);
      router.post('/watch/rules/remove', watchRuleRemoveHandler);
      router.get('/watch/report', watchReportHandler);
      router.post('/watch/feedback', watchFeedbackHandler);
      router.post('/watch/mute', watchMuteHandler(false));
      router.post('/watch/unmute', watchMuteHandler(true));
      router.post('/watch/replay', watchReplayHandler);
      routesRegistered = true;
    },
    stop: () => {
      lifecycleGeneration += 1;
      if (typeof app.setPluginStatus === 'function') {
        app.setPluginStatus('Watchkeeper stopped.');
      }
      watchService.stop();
      pluginOptions = {};
      running = false;
    }
  };
};
