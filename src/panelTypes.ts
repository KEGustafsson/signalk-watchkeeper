import type { EmbeddedWebAppApi } from './types.js';

export interface AppPanelProps extends EmbeddedWebAppApi {
  readonly serverId?: string;
  /** A fetch for the plugin's routes (tests and the preview host); the browser's otherwise. */
  readonly watchFetch?: typeof fetch;
  /** Where the plugin is mounted; `/plugins/signalk-watchkeeper` by default. */
  readonly pluginBase?: string;
}
