import React from 'react';
import WatchPanel from './WatchPanel.js';
import type { AppPanelProps } from './panelTypes.js';

export const DEFAULT_PLUGIN_BASE = '/plugins/signalk-watchkeeper';

/** `/watch/status` and friends, relative to wherever the plugin is mounted. */
export function pluginEndpoint(props: AppPanelProps, route: string): string {
  const base = typeof props.pluginBase === 'string' && props.pluginBase.length > 0 ? props.pluginBase : DEFAULT_PLUGIN_BASE;
  return `${base.replace(/\/+$/, '')}${route}`;
}

export default function AppPanel(props: AppPanelProps) {
  const endpoint = React.useCallback((route: string) => pluginEndpoint(props, route), [props.pluginBase]);
  const status = props.loginStatus;
  // Reading needs no login; muting, feedback, rules and replay need write access.
  const needsLogin = Boolean(status && status.authenticationRequired && status.status !== 'loggedIn');
  const readOnly = Boolean(status && status.status === 'loggedIn' && status.readOnlyAccess);

  return (
    <section style={{ padding: '1rem', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ marginTop: 0 }}>Signal K Watchkeeper</h2>
      <p>
        A background watch of every Signal K path: it learns how each one normally behaves and raises a Signal K
        notification when one departs from it.
      </p>
      {needsLogin ? (
        <p style={{ color: '#b45309' }}>
          Log in with write access to mute paths, give feedback, change watch rules or replay history.{' '}
          {typeof props.login === 'function' ? (
            <button type="button" onClick={() => props.login && props.login()}>
              Log in
            </button>
          ) : null}
        </p>
      ) : readOnly ? (
        <p style={{ color: '#b45309' }}>This login has read-only access: muting, feedback, rules and replay need write access.</p>
      ) : null}
      <WatchPanel fetchImpl={props.watchFetch} endpoint={endpoint} />
    </section>
  );
}
