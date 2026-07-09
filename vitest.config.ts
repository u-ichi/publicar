import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: {
              configPath: "./wrangler.toml"
            },
            miniflare: {
              bindings: {
                DEV_MODE: "true",
                GOOGLE_CLIENT_ID: "test-client-id",
                GOOGLE_CLIENT_SECRET: "test-client-secret",
                TOKEN_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
                SESSION_SECRET: "test-session-secret-with-at-least-32-chars",
                ALLOWED_SIGNUP_DOMAINS: "example.com",
                SESSION_TTL_SECONDS: "604800",
                OAUTH_STATE_TTL_SECONDS: "600"
              }
            }
          })
        ],
        test: {
          name: "worker",
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          exclude: ["node_modules/**", "plugins/**", "test/plugin/**"],
          pool: "@cloudflare/vitest-pool-workers"
        }
      }
    ]
  }
});
