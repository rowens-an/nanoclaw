---
name: add-teams
description: Add Microsoft Teams as a channel via Microsoft Graph API with delegated OAuth. Uses delta queries for polling. Requires Azure AD app with admin consent.
---

# Add Microsoft Teams Channel

This skill adds Microsoft Teams support to NanoClaw using Microsoft Graph API with delegated OAuth authentication and delta query polling.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `teams` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

**Do they already have an Azure AD app configured?** If yes, collect the client_id, client_secret, and tenant_id now. If no, we'll create one in Phase 3.

**Important**: This integration requires `ChannelMessage.Read.All` permission which needs Azure AD admin consent. Confirm the user has (or can get) admin access.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-teams
```

This deterministically:
- Adds `src/channels/teams.ts` (TeamsChannel class with self-registration via `registerChannel`)
- Adds `src/channels/teams.test.ts` (unit tests)
- Appends `import './teams.js'` to the channel barrel file `src/channels/index.ts`
- Installs `@azure/msal-node` and `@microsoft/microsoft-graph-client` npm dependencies
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new teams tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Azure AD App (if needed)

If the user doesn't have an Azure AD app, share [TEAMS_SETUP.md](TEAMS_SETUP.md) which has step-by-step Azure portal instructions.

Quick summary of what's needed:
1. Register app in Azure AD (single tenant)
2. Note the Application (client) ID and Directory (tenant) ID
3. Create a client secret
4. Add delegated permissions: `ChannelMessage.Read.All`, `ChannelMessage.Send`, `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `User.Read`
5. Grant admin consent (requires Azure AD admin)

Wait for the user to provide client_id, client_secret, and tenant_id.

### Save OAuth config

```bash
mkdir -p ~/.teams-mcp
cat > ~/.teams-mcp/oauth-config.json << EOF
{
  "client_id": "$CLIENT_ID",
  "client_secret": "$CLIENT_SECRET",
  "tenant_id": "$TENANT_ID"
}
EOF
```

### Run device code authentication

Run the MSAL device code flow to authenticate the user and obtain refresh tokens:

```bash
npx tsx -e "
const { ConfidentialClientApplication } = require('@azure/msal-node');
const fs = require('fs');
const path = require('path');

const config = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.teams-mcp/oauth-config.json'), 'utf-8'));

const msalConfig = {
  auth: {
    clientId: config.client_id,
    clientSecret: config.client_secret,
    authority: 'https://login.microsoftonline.com/' + config.tenant_id,
  },
};

const cca = new ConfidentialClientApplication(msalConfig);

const scopes = [
  'https://graph.microsoft.com/ChannelMessage.Read.All',
  'https://graph.microsoft.com/ChannelMessage.Send',
  'https://graph.microsoft.com/Team.ReadBasic.All',
  'https://graph.microsoft.com/Channel.ReadBasic.All',
  'https://graph.microsoft.com/User.Read',
];

(async () => {
  const result = await cca.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => {
      console.log(response.message);
    },
  });

  const credentials = {
    access_token: result.accessToken,
    refresh_token: result.account?.homeAccountId, // MSAL manages cache internally
    expires_on: Math.floor(result.expiresOn.getTime() / 1000),
  };

  fs.writeFileSync(
    path.join(process.env.HOME, '.teams-mcp/credentials.json'),
    JSON.stringify(credentials, null, 2),
  );

  console.log('Tokens saved to ~/.teams-mcp/credentials.json');
})();
"
```

Tell the user:
> A URL and code will appear. Open the URL in your browser, sign in with your Microsoft account, and enter the code. This grants NanoClaw delegated access to read and send Teams channel messages.

Verify the credentials file was created:

```bash
ls -la ~/.teams-mcp/credentials.json
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### List available teams and channels

After the service starts, check logs for available teams:

```bash
tail -20 logs/nanoclaw.log | grep -i teams
```

Or query the DB:

```bash
sqlite3 store/messages.db "SELECT jid, name FROM chat_names WHERE jid LIKE 'teams:%'"
```

### Get Team and Channel IDs

Tell the user:

> I need the Team ID and Channel ID where you want the bot to operate.
>
> You can find these in the Teams web app URL:
> `https://teams.microsoft.com/l/channel/{channelId}/{channelName}?groupId={teamId}`
>
> Or I can list your joined teams and channels if you'd like.
>
> The JID format is: `teams:{teamId}:{channelId}`
> Example: `teams:7155e3c8-175e-4311-97ef-572edc3aa3db:19:0ea5de04de4743bcb4cd20cb99235d99@thread.tacv2`

Wait for the user to provide the team and channel IDs.

### Register the channel

For a main channel (responds to all messages):

```typescript
registerGroup("teams:<teamId>:<channelId>", {
  name: "<team-name> / <channel-name>",
  folder: "teams_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional channels (trigger-only):

```typescript
registerGroup("teams:<teamId>:<channelId>", {
  name: "<team-name> / <channel-name>",
  folder: "teams_<channel-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in your registered Teams channel:
> - For main channel: Any message works
> - For non-main: @mention the bot or use `@<assistant-name> hello`
>
> The bot should respond within 15-30 seconds (polling interval).

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -iE "(teams|Teams)"
```

### Verify in DB

```bash
sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'teams:%'"
```

## Troubleshooting

### Bot not responding

1. Check credentials exist: `ls -la ~/.teams-mcp/`
2. Check channel is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'teams:%'"`
3. For non-main channels: message must include trigger pattern
4. Service is running: `launchctl list | grep nanoclaw`

### "Insufficient privileges" or 403 errors

- `ChannelMessage.Read.All` requires admin consent. Verify in Azure Portal:
  - Go to App registrations > your app > API permissions
  - All permissions should have a green checkmark under "Status"
- If consent was recently granted, it may take a few minutes to propagate

### Token expired / refresh failures

Re-run the device code authentication from Phase 3:
```bash
rm ~/.teams-mcp/credentials.json
# Re-run the device code flow script
```

### Messages delayed

- The default poll interval is 15 seconds. Messages may take up to 15-30 seconds to appear.
- If you see backoff messages in logs, there may be API errors causing exponential backoff (up to 30 minutes).

### Delta token errors (410 Gone)

This is normal after extended downtime. The channel automatically resets the delta token and re-syncs.

## Known Limitations

- **Admin consent required** — `ChannelMessage.Read.All` needs Azure AD admin to grant consent
- **Polling latency** — 15-30s delay between message sent and bot seeing it (vs real-time for Slack/Discord)
- **No typing indicator** — Graph API doesn't support typing indicators in polling mode
- **Threads are flattened** — Channel replies are polled as flat messages; responses go to channel root
- **Text only** — No Adaptive Cards, file attachments, or rich content
- **Single-tenant only** — Initial implementation assumes single Azure AD tenant
- **Requires Azure AD app** — More complex setup than other channels (needs Azure portal access)

## Removal

1. Delete `src/channels/teams.ts` and `src/channels/teams.test.ts`
2. Remove `import './teams.js'` from `src/channels/index.ts`
3. Uninstall: `npm uninstall @azure/msal-node @microsoft/microsoft-graph-client`
4. Remove `teams` from `.nanoclaw/state.yaml`
5. Optionally remove credentials: `rm -rf ~/.teams-mcp`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux)
