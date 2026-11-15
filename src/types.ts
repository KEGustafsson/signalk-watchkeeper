/** What the Signal K admin UI hands an embedded webapp. */
export interface EmbeddedWebAppApi {
  readonly isLoggedIn?: boolean;
  readonly login?: () => void;
  readonly loginStatus?: {
    readonly status?: 'notLoggedIn' | 'loggedIn';
    readonly authenticationRequired?: boolean;
    /** The server's "Allow Readonly Access" setting (read access without a login), not this login's level. */
    readonly readOnlyAccess?: boolean;
    /** This login's level: "admin", "readwrite" or "readonly". */
    readonly userLevel?: string;
    readonly username?: string;
    readonly [key: string]: unknown;
  };
}
