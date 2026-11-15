/** What the Signal K admin UI hands an embedded webapp. */
export interface EmbeddedWebAppApi {
  readonly isLoggedIn?: boolean;
  readonly login?: () => void;
  readonly loginStatus?: {
    readonly status?: 'notLoggedIn' | 'loggedIn';
    readonly authenticationRequired?: boolean;
    readonly readOnlyAccess?: boolean;
    readonly username?: string;
    readonly [key: string]: unknown;
  };
}
