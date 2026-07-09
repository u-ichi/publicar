# Contributing

Thank you for contributing to publicar.

## Development setup

Use the local setup in [docs/local-development.md](docs/local-development.md).
The short version is:

```bash
npm install
npm run typecheck
npm test
```

Copy `.dev.vars.example` to `.dev.vars` for local development secrets. Do not
commit `.dev.vars`, production `wrangler.toml` values, access tokens, or other
private operational files.

## Issues

Use GitHub Issues for bugs and feature requests.

For bug reports, include:

- What you expected to happen
- What actually happened
- Reproduction steps
- Relevant logs or screenshots, with secrets removed

For feature requests, include:

- The use case
- The proposed behavior
- Any compatibility or security considerations

Report security issues privately using [SECURITY.md](SECURITY.md), not public
issues.

## Pull requests

- Create branches with short descriptive names, such as `fix/oauth-state` or
  `docs/setup-notes`.
- Keep changes scoped to one purpose.
- Write commit messages in a clear imperative style, such as
  `Fix OAuth callback validation`.
- Update docs and tests when behavior changes.
- Ensure CI passes before requesting review.

## Code style

- Follow the existing TypeScript style in the repository.
- Keep `tsconfig.json` strictness intact.
- Prefer explicit validation at auth, access-control, and upload boundaries.
- Avoid broad refactors when a focused change is enough.

## Tests

Run these before submitting a pull request:

```bash
npm run typecheck
npm test
```

For Workers runtime changes, also run the local development server and confirm
the affected behavior directly.

## Contributor license

By submitting a contribution, you agree that your contribution is licensed under
the Apache License 2.0 used by this project. No separate Contributor License
Agreement is required.
