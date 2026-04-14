export type ControlPlaneAuthMode = 'anonymous' | 'invalid' | 'session' | 'shared-token';

export interface ControlPlaneAuthSnapshot {
  readonly authenticated: boolean;
  readonly authMode: ControlPlaneAuthMode;
  readonly tokenPresent: boolean;
  readonly authorizationHeaderPresent: boolean;
  readonly sessionCookiePresent: boolean;
  readonly principalId: string | null;
  readonly principalKind: 'user' | 'bot' | 'service' | 'token' | null;
  readonly admin: boolean;
  readonly scopes: readonly string[];
  readonly roles: readonly string[];
}
