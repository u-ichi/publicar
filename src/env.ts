export type Env = {
  DEV_MODE?: string;
  DB: D1Database;
  SESSIONS: KVNamespace;
  CACHE_BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  ALLOWED_SIGNUP_DOMAINS?: string;
  GOOGLE_REDIRECT_URI?: string;
  GOOGLE_TOKEN_URL?: string;
  GOOGLE_JWKS_URL?: string;
  GOOGLE_USERINFO_URL?: string;
  GOOGLE_DRIVE_API_BASE_URL?: string;
  GOOGLE_DRIVE_UPLOAD_BASE_URL?: string;
  TEAM_DRIVE_ID?: string;
  DEFAULT_VISIBILITY?: string;
  MAX_UPLOAD_BYTES?: string;
  SESSION_TTL_SECONDS?: string;
  OAUTH_STATE_TTL_SECONDS?: string;
  ACCESS_LOG_RETENTION_DAYS?: string;
};

export type AuthUser = {
  id: string;
  googleId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export type AppVariables = {
  user: AuthUser;
  authMethod?: "session" | "api-key";
  apiKeyScopes?: string[];
  apiKeyId?: string;
};

export type AppBindings = {
  Bindings: Env;
  Variables: AppVariables;
};
