import type { Context } from "hono";
import type { AppBindings } from "../../env";

export function driveFailureResponse(c: Context<AppBindings>, error: unknown): Response | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const message = error.message;
  if (message.includes("Google account must be reauthorized")) {
    return c.json({ error: "google_reauthorization_required" }, 401);
  }
  if (message.includes("Google token refresh failed")) {
    return c.json({ error: "google_token_refresh_failed" }, 401);
  }
  if (message.includes("Google Drive API has not been used") || message.includes("drive.googleapis.com")) {
    return c.json({ error: "google_drive_api_disabled" }, 503);
  }
  if (message.includes("Drive ") && message.includes(" failed with 403")) {
    return c.json({ error: "google_drive_forbidden" }, 403);
  }
  if (message.includes("Drive ") && message.includes(" failed with 404")) {
    return c.json({ error: "google_drive_not_found" }, 404);
  }
  if (message.startsWith("Drive ")) {
    return c.json({ error: "google_drive_error" }, 502);
  }
  return null;
}

export function driveDeleteFailureResponse(c: Context<AppBindings>, error: unknown): Response | null {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Google account must be reauthorized")) {
    return c.json({ error: "google_reauthorization_required" }, 401);
  }
  if (message.startsWith("Drive ")) {
    return c.json({ error: "google_drive_error" }, 502);
  }
  return null;
}
