# publicar

[日本語版 README](README.ja.md)

## Overview

publicar is a self-hosted HTML and ZIP hosting service that runs on Cloudflare Workers.
It lets a team publish generated reports, documentation, and reviewable HTML pages behind Google OAuth or a controlled public URL.

The service stores source files in Google Drive, caches delivered files in Cloudflare R2, and exposes a small API that AI agents and CLI tools can use to create projects and deploy files.

## Key features

- **Google OAuth authentication** with allowed-domain checks.
- **HTML and ZIP deploys** for single-page reports or multi-file sites with CSS, JavaScript, images, and fonts.
- **API key authentication** using `pub_...` keys for CLI and AI-agent workflows.
- **AI agent discovery** through `/llms.txt` and `/api/v1/openapi.json`.
- **Review and comment workflow** for authenticated users viewing published HTML.
- **Project management UI** for projects, files, members, deploy history, access logs, and API keys.
- **Self-hosted Cloudflare stack** using Workers, D1, KV, and R2.

## Quick start

```bash
git clone https://github.com/u-ichi/publicar.git
cd publicar
npm install
cp wrangler.toml.example wrangler.toml
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your Google OAuth client and local secrets.
npm run dev
# Open http://localhost:8787
```

For local setup details, see [Local development](docs/local-development.md).

Docker is also supported:

```bash
cp .dev.vars.example .dev.vars
docker compose up --build
# Open http://localhost:8787
```

## Deploy

Use the [setup guide](docs/setup.md) to create Cloudflare resources, configure Google OAuth, apply D1 migrations, and deploy your own instance.

Google OAuth client setup is documented in [Google OAuth setup](docs/google-oauth-setup.md).

The production setup flow is:

1. Create a Cloudflare D1 database, KV namespace, and R2 bucket.
2. Create a Google OAuth web client and enable Google Drive API.
3. Copy `wrangler.toml.example` to `wrangler.toml` and fill in resource IDs.
4. Set encrypted Cloudflare secrets for `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, and `SESSION_SECRET`.
5. Apply D1 migrations.
6. Run `npm run deploy`.

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/llms.txt` | Service description for AI agents |
| `GET` | `/api/v1/openapi.json` | OpenAPI 3.1.0 specification |
| `POST` | `/api/v1/projects` | Create a project |
| `GET` | `/api/v1/projects` | List projects |
| `GET` | `/api/v1/projects/{id}` | Get project details |
| `PATCH` | `/api/v1/projects/{id}` | Update a project |
| `DELETE` | `/api/v1/projects/{id}` | Delete a project |
| `POST` | `/api/v1/projects/{id}/deploy` | Deploy one file or a ZIP archive |
| `GET` | `/api/v1/api-keys` | List API keys |
| `POST` | `/api/v1/api-keys` | Create an API key |
| `DELETE` | `/api/v1/api-keys/{id}` | Delete an API key |
| `GET` | `/auth/cli` | Start the CLI authentication flow |
| `GET` | `/auth/cli/poll` | Poll the CLI authentication flow |

Use `Authorization: Bearer pub_...` for API-key authenticated requests.

## AI agent integration

AI agents can discover the service through:

- `GET /llms.txt`
- `GET /api/v1/openapi.json`

Create an API key from the UI or the API, then deploy an HTML file with curl:

```bash
curl -X POST "https://your-domain/api/v1/projects/<project-id>/deploy?path=index.html" \
  -H "Authorization: Bearer pub_..." \
  -H "Content-Type: text/html" \
  --data-binary @report.html
```

Deploy a ZIP archive that contains `index.html` plus assets:

```bash
curl -X POST "https://your-domain/api/v1/projects/<project-id>/deploy" \
  -H "Authorization: Bearer pub_..." \
  -H "Content-Type: application/zip" \
  --data-binary @site.zip
```

The response includes the project URL and deployed entry path. ZIP entries are normalized before storage, and invalid paths are rejected.

## Tech stack

- **Runtime**: Cloudflare Workers + [Hono](https://hono.dev/) with TypeScript
- **Database**: Cloudflare D1
- **File cache**: Cloudflare R2
- **Sessions**: Cloudflare KV
- **Primary file storage**: Google Drive
- **Testing**: Vitest + `@cloudflare/vitest-pool-workers`
- **CI**: GitHub Actions

## Development

```bash
npm run dev          # Start wrangler dev
npm run typecheck    # Run TypeScript type checks
npm test             # Run the test suite
npm run deploy       # Deploy with wrangler
```

Local development requires `.dev.vars`; copy it from `.dev.vars.example` and fill in Google OAuth values and local secrets. See [Local development](docs/local-development.md) for the full workflow.

Before opening a pull request, run:

```bash
npm run typecheck
npm test
```

## License

publicar is licensed under the [Apache License 2.0](LICENSE).
