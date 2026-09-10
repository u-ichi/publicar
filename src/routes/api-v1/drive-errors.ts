import type { Context } from "hono";
import type { AppBindings } from "../../env";

export function driveFailureResponse(c: Context<AppBindings>, error: unknown): Response | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const message = error.message;
  if (message === "project_owner_required") return c.json({ error: message }, 403);
  if (message === "service_account_not_configured" || message === "service_account_mismatch" || message === "service_account_root_not_configured") return c.json({ error: message }, 503);
  if (message === "service_account_location_denied") return c.json({ error: message }, 403);
  if (message === "project_drive_folder_required") return c.json({ error: message }, 400);
  if (message === "project_storage_changed") return c.json({ error: message }, 409);
  if (message.startsWith("service_account_token_")) return c.json({ error: "service_account_authentication_failed" }, 502);
  if (message === "Automation Drive location is not allowed") {
    return c.json({ error: "drive_location_not_allowed" }, 403);
  }
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
