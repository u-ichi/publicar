# Security Policy

## Supported scope

This policy covers the publicar application, including authentication, OAuth
handling, session cookies, API keys, project access control, uploaded HTML/ZIP
delivery, and Cloudflare Workers deployment paths.

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/u-ichi/publicar/security/advisories/new).

Do not open a public GitHub issue for a vulnerability report. GitHub Security
Advisories keep the discussion private with the maintainers until a coordinated
disclosure is agreed upon.

## Response targets

- Initial response: within 3 business days
- Triage update: within 7 business days when reproduction is possible
- Fix or mitigation target: depends on severity and exploitability; critical
  authentication, authorization, or data exposure issues are prioritized first

## Coordinated disclosure

We follow responsible disclosure. Please give maintainers a reasonable window
to validate, fix, and release a mitigation before publishing details. If a CVE
is appropriate, maintainers will coordinate the advisory and release notes.

## In scope

- Authentication bypass or OAuth state/token handling issues
- Unauthorized access to private, invite-only, domain, or link-shared projects
- API key exposure, weak verification, or privilege escalation
- Cross-site scripting in rendered pages or management UI
- Unsafe HTML/ZIP upload handling
- Signed URL or cache object access control issues

## Out of scope

- Denial-of-service testing or resource exhaustion
- Social engineering, phishing, or physical attacks
- Findings that require access to another user's credentials or private data
- Scanner-only reports without a concrete exploit path
- Issues in third-party services unless publicar usage introduces the weakness

## Safe harbor

Good-faith research is welcome when it is limited to environments and accounts
you control. Do not access, modify, delete, or exfiltrate real user data. Do not
perform destructive testing, denial-of-service, spam, or persistence attempts.
Stop testing and report promptly if you encounter data that is not yours.
