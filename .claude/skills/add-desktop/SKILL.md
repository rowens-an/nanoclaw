---
name: add-desktop
description: Add a local macOS desktop channel. Runs an HTTP+WebSocket server on localhost for the native SwiftUI chat app.
---

# Add Desktop Channel

This skill adds a localhost desktop channel to NanoClaw, enabling a native macOS chat app to communicate with the agent.

## Phase 1: Apply Code Changes

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-desktop
```

This:
- Adds `src/channels/desktop.ts` (DesktopChannel class with HTTP+WebSocket server)
- Adds `src/channels/desktop.test.ts` (unit tests)
- Appends `import './desktop.js'` to `src/channels/index.ts`
- Installs `ws` and `@types/ws` npm dependencies

### Validate

```bash
npm test
npm run build
```

## Phase 2: Configure

Add to `.env`:

```bash
DESKTOP_ENABLED=true
DESKTOP_PORT=19280
# Optional: set a token to require auth
# DESKTOP_AUTH_TOKEN=your-secret-token
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 3: Create a Group

Create a desktop group via REST:

```bash
curl -X POST http://127.0.0.1:19280/api/groups \
  -H 'Content-Type: application/json' \
  -d '{"name": "My Project"}'
```

Then register it as a NanoClaw group (via main channel or IPC).

## Phase 4: Connect the App

Open the SwiftUI app at `desktop/NanoClaw/`. It connects to `ws://127.0.0.1:19280/ws`.

## API Reference

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/status` | Connection status |
| `GET` | `/api/groups` | List desktop groups |
| `POST` | `/api/groups` | Create group (`{"name": "..."}`) |
| `DELETE` | `/api/groups/:jid` | Remove group |
| `GET` | `/api/groups/:jid/messages` | Message history |
| `WS` | `/ws` | WebSocket for real-time messaging |
