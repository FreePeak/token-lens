# Support

## Getting Help

If you need help with Token Lens, here are the best ways to get it:

### Documentation

- [README](README.md) — setup, usage, and architecture
- [CONTRIBUTING](CONTRIBUTING.md) — development guide

### Issues

- [Bug report](https://github.com/FreePeak/token-lens/issues/new?template=bug_report.md) — something isn't working
- [Feature request](https://github.com/FreePeak/token-lens/issues/new?template=feature_request.md) — something you'd like to see
- [Documentation](https://github.com/FreePeak/token-lens/issues/new?template=documentation.md) — something missing or unclear

### Discussions

- [GitHub Discussions](https://github.com/FreePeak/token-lens/discussions) — questions, ideas, and community help

## Common Issues

**Dashboard shows "no sessions"**
Run `bun run backfill` to import historical sessions. Make sure Cursor has been used on this machine.

**"Missing usage profiles" for sync-usage**
Token Lens needs your Cursor dashboard session token. This is read automatically from `state.vscdb` — if it's missing, you may need to log into Cursor first.

**Hooks not working**
Run `bun run install-hooks`, then restart Cursor. Check that `~/.cursor/hooks.json` contains the token-lens entry.

**Port 5173 already in use**
Use `bun run serve --port 5180` to pick a different port.
