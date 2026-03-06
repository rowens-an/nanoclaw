# Microsoft Teams Setup Guide

Step-by-step guide to create an Azure AD app registration for NanoClaw Teams integration.

## Prerequisites

- An Azure AD tenant (comes with any Microsoft 365 subscription)
- Azure AD admin access (needed to grant admin consent for `ChannelMessage.Read.All`)
- A Microsoft Teams channel where the bot will operate

## Step 1: Register the Application

1. Go to [Azure Portal](https://portal.azure.com)
2. Navigate to **Azure Active Directory** > **App registrations** > **New registration**
3. Fill in:
   - **Name**: `NanoClaw Teams Bot`
   - **Supported account types**: "Accounts in this organizational directory only" (Single tenant)
   - **Redirect URI**: Leave blank (not needed for device code flow)
4. Click **Register**

## Step 2: Note Application IDs

From the app's **Overview** page, copy:
- **Application (client) ID** — this is your `client_id`
- **Directory (tenant) ID** — this is your `tenant_id`

## Step 3: Create Client Secret

1. Go to **Certificates & secrets** > **Client secrets** > **New client secret**
2. Description: `NanoClaw` (or anything memorable)
3. Expiration: Choose based on your preference (recommended: 24 months)
4. Click **Add**
5. **Copy the secret value immediately** — it won't be shown again. This is your `client_secret`.

## Step 4: Add API Permissions

1. Go to **API permissions** > **Add a permission** > **Microsoft Graph** > **Delegated permissions**
2. Add these permissions:

| Permission | Purpose | Admin Consent Required? |
|-----------|---------|----------------------|
| `ChannelMessage.Read.All` | Read channel messages via delta queries | **Yes** |
| `ChannelMessage.Send` | Send messages to channels | No |
| `Team.ReadBasic.All` | List joined teams | No |
| `Channel.ReadBasic.All` | List channels in teams | No |
| `User.Read` | Get signed-in user profile | No |

3. Click **Add permissions**

## Step 5: Grant Admin Consent

**Important**: `ChannelMessage.Read.All` requires admin consent.

1. On the **API permissions** page, click **Grant admin consent for [your tenant]**
2. Confirm by clicking **Yes**
3. All permissions should show a green checkmark under "Status"

If you are not an Azure AD admin, you'll need to ask your admin to grant consent. They can do this from:
- The same API permissions page in the Azure Portal
- Or via the admin consent URL: `https://login.microsoftonline.com/{tenant_id}/adminconsent?client_id={client_id}`

## Step 6: Save Configuration

Create the config file at `~/.teams-mcp/oauth-config.json`:

```bash
mkdir -p ~/.teams-mcp
cat > ~/.teams-mcp/oauth-config.json << 'EOF'
{
  "client_id": "YOUR_CLIENT_ID_HERE",
  "client_secret": "YOUR_CLIENT_SECRET_HERE",
  "tenant_id": "YOUR_TENANT_ID_HERE"
}
EOF
```

Replace the placeholder values with your actual IDs from Steps 2 and 3.

## Troubleshooting

### "Insufficient privileges" error
- Ensure admin consent was granted (Step 5)
- Check that all 5 permissions are listed and have green checkmarks

### "AADSTS700016: Application not found"
- Verify the `tenant_id` and `client_id` are correct
- Ensure the app registration is in the correct Azure AD tenant

### "AADSTS7000218: The request body must contain client_assertion or client_secret"
- Verify the `client_secret` value is correct and hasn't expired
- Go to **Certificates & secrets** to check expiration dates

### Client secret expired
- Create a new client secret (Step 3)
- Update `~/.teams-mcp/oauth-config.json` with the new value

### Multi-tenant not supported
- This integration is single-tenant only. The app registration must be in the same tenant where you use Teams.
