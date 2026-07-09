import { Hono } from "hono";
import { createSession, clearSessionCookie, destroySession, getSessionUser } from "./auth/session";
import { createLoginUrl, handleOAuthCallback } from "./auth/oauth";
import { deleteOldAccessLogs } from "./db/access-logs";
import type { AppBindings, Env } from "./env";
import { requireAuth, requireScope, resolveAuth } from "./middleware/auth";
import { apiKeysRoute } from "./routes/api-v1/api-keys";
import { commentsRoute } from "./routes/api-v1/comments";
import { deployProject } from "./routes/api-v1/deploy";
import { notificationsRoute } from "./routes/api-v1/notifications";
import { openapiSpec } from "./routes/api-v1/openapi";
import { assetsRoute } from "./routes/assets";
import { cliAuthRoute } from "./routes/auth-cli";
import { home, projectDetail, projectReview } from "./routes/home";
import { projectsRoute } from "./routes/api-v1/projects";
import { serveProject } from "./routes/serve";
import { llmsTxt } from "./routes/wellknown";

const app = new Hono<AppBindings>();

app.get("/health", (c) => {
  return c.json({
    ok: true,
    devMode: c.env.DEV_MODE === "true"
  });
});

app.route("/", assetsRoute);

app.get("/auth/login", async (c) => {
  return c.redirect(await createLoginUrl(c.req.raw, c.env), 302);
});

app.get("/auth/callback", async (c) => {
  try {
    const { user, redirectTo } = await handleOAuthCallback(c.req.raw, c.env);
    const response = c.redirect(redirectTo, 302);
    response.headers.append("Set-Cookie", await createSession(c.env, user));
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth callback failed";
    if (message.includes("domain is not allowed")) {
      return c.json({ error: "forbidden" }, 403);
    }
    return c.json({ error: "invalid_oauth_callback" }, 400);
  }
});

app.get("/auth/logout", async (c) => {
  await destroySession(c.req.raw, c.env);
  const response = c.redirect("/", 302);
  response.headers.append("Set-Cookie", clearSessionCookie(c.env));
  return response;
});

app.get("/auth/me", async (c) => {
  const user = await getSessionUser(c.req.raw, c.env);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({ user });
});

app.route("/auth", cliAuthRoute);
app.get("/llms.txt", llmsTxt);
app.get("/api/v1/openapi.json", openapiSpec);

app.use("*", resolveAuth);
app.use("/api/*", requireAuth);

app.get("/api/v1/whoami", (c) => {
  return c.json({ user: c.get("user") });
});

// commentsRoute must stay before projectsRoute so project subresources
// (/:id/comments, /:id/comment-threads, /:id/review-content) are not
// consumed by projectsRoute's /:id handlers.
app.route("/api/v1/projects", commentsRoute);
app.route("/api/v1/projects", projectsRoute);
app.route("/api/v1/api-keys", apiKeysRoute);
app.route("/api/v1/notifications", notificationsRoute);
app.post("/api/v1/projects/:id/deploy", requireScope("deploy"), deployProject);
app.get("/p/:alias", serveProject);
app.get("/p/:alias/", serveProject);
app.get("/p/:alias/:path{.*}", serveProject);

app.get("/", home);
app.get("/projects/:id", projectDetail);
app.get("/projects/:id/review", projectReview);
app.get("/:alias", serveProject);
app.get("/:alias/", serveProject);
app.get("/:alias/:path{.*}", serveProject);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const days = parseInt(env.ACCESS_LOG_RETENTION_DAYS ?? "90", 10);
    if (days > 0) {
      ctx.waitUntil(deleteOldAccessLogs(env, days));
    }
  }
};
