# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x     | :white_check_mark: |

## Reporting a Vulnerability

Token Lens reads local state databases and optionally makes authenticated requests to Cursor's dashboard API using your local session cookie. **No data is transmitted anywhere else.**

If you discover a security vulnerability, please **do not** open a public issue. Instead, email the maintainer directly or open a draft security advisory on GitHub:

1. Go to https://github.com/FreePeak/token-lens/security/advisories
2. Click "New draft security advisory"
3. Fill in the details

You should receive a response within 48 hours. If the issue is confirmed, a patch will be released as soon as possible.

## What to Report

- Unauthorized data access or leakage
- Data written outside of `~/.token-lens/`
- Code execution vulnerabilities
- Authentication/session token exposure

## Bug Bounty

This is a free open-source project. No bug bounty program is currently in place, but your report will be credited in release notes.
