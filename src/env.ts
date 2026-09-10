export type Env = {
  DEV_MODE?: string;
  DB: D1Database;
  SESSIONS: KVNamespace;
  CACHE_BUCKET: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_ROOT_FOLDER_ID?: string;
  MAX_EXPANDED_UPLOAD_BYTES?: string;
  MAX_UPLOAD_FILES?: string;
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
  AUTOMATION_ORGANIZATION_ID?: string;
  ORGANIZATION_ADMIN_EMAILS?: string;
  SECURITY_LOG_RETENTION_DAYS?: string;
};

export type UserKind = "member" | "guest";

export type AuthUser = {
  id: string;
  googleId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  kind: UserKind;
};

export type AppVariables = {
  user: AuthUser;
  authMethod?: "session" | "api-key" | "upload-key";
  principal?: { kind: "user"; user: AuthUser } | { kind: "upload-key"; keyId: string; projectId: string };
  uploadKey?: { id: string; projectId: string };
  rejectionReason?: string;
  auditedUploadKeyId?: string;
  driveServiceAccount?: string;
  legacyDeploy?: { id: string; deadline: number };
  apiKeyScopes?: string[];
  apiKeyId?: string;
  apiKeyProjectId?: string | null;
};

export type AppBindings = {
  Bindings: Env;
  Variables: AppVariables;
};
