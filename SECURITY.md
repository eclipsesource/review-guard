# Security Policy

ReviewGuard MCP is a safety boundary between AI agents and a write-enabled GitHub
token. Reports about anything that lets an agent bypass a gate are especially
valuable: submitting without `--allow-submit`, removing the fixed disclaimer,
escaping the `--repo`/`--pr` scope, or resolving other users' threads.

## Supported versions

Only the latest released version receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue** for vulnerabilities. Instead, use GitHub's
private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Describe the issue, affected configuration (flags, transport), and reproduction steps.

We will acknowledge the report, keep you informed of progress, and credit you in
the advisory unless you prefer otherwise.
