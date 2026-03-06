import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  ConfidentialClientApplication,
  Configuration,
  AuthenticationResult,
} from '@azure/msal-node';
import { Client } from '@microsoft/microsoft-graph-client';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

// Teams messages have a 4096 character limit per message.
const MAX_MESSAGE_LENGTH = 4096;

const CRED_DIR = path.join(os.homedir(), '.teams-mcp');
const OAUTH_CONFIG_PATH = path.join(CRED_DIR, 'oauth-config.json');
const CREDENTIALS_PATH = path.join(CRED_DIR, 'credentials.json');

interface OAuthConfig {
  client_id: string;
  client_secret: string;
  tenant_id: string;
}

interface StoredCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_on?: number;
}

export interface TeamsChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class TeamsChannel implements Channel {
  name = 'teams';

  private msalClient: ConfidentialClientApplication | null = null;
  private graphClient: Client | null = null;
  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;
  private pollIntervalMs: number;
  private deltaTokens = new Map<string, string>();
  private userNameCache = new Map<string, string>();
  private botUserId = '';
  private outgoingQueue: Array<{ jid: string; text: string; sender?: string }> = [];
  private flushing = false;

  private opts: TeamsChannelOpts;

  constructor(opts: TeamsChannelOpts, pollIntervalMs = 15000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    if (!fs.existsSync(OAUTH_CONFIG_PATH) || !fs.existsSync(CREDENTIALS_PATH)) {
      logger.warn(
        'Teams credentials not found in ~/.teams-mcp/. Skipping Teams channel. Run /add-teams to set up.',
      );
      return;
    }

    const oauthConfig: OAuthConfig = JSON.parse(
      fs.readFileSync(OAUTH_CONFIG_PATH, 'utf-8'),
    );
    const credentials: StoredCredentials = JSON.parse(
      fs.readFileSync(CREDENTIALS_PATH, 'utf-8'),
    );

    const msalConfig: Configuration = {
      auth: {
        clientId: oauthConfig.client_id,
        clientSecret: oauthConfig.client_secret,
        authority: `https://login.microsoftonline.com/${oauthConfig.tenant_id}`,
      },
    };

    this.msalClient = new ConfidentialClientApplication(msalConfig);

    // Acquire initial token using refresh token
    const tokenResult = await this.acquireToken(credentials);
    if (!tokenResult) {
      logger.error('Teams: failed to acquire initial access token');
      return;
    }

    // Initialize Graph client with token provider
    this.graphClient = Client.init({
      authProvider: async (done) => {
        try {
          const token = await this.getAccessToken();
          done(null, token);
        } catch (err) {
          done(err as Error, null);
        }
      },
    });

    // Get bot user profile
    try {
      const me = await this.graphClient.api('/me').get();
      this.botUserId = me.id;
      logger.info(
        { userId: this.botUserId, displayName: me.displayName },
        'Teams channel connected',
      );
    } catch (err) {
      logger.warn({ err }, 'Teams connected but failed to get user profile');
    }

    this.connected = true;

    // Flush queued messages
    await this.flushOutgoingQueue();

    // Initial poll + start poll loop
    await this.pollForMessages().catch((err) =>
      logger.error({ err }, 'Teams initial poll error'),
    );
    this.schedulePoll();
  }

  async sendMessage(jid: string, text: string, sender?: string): Promise<void> {
    const parsed = this.parseJid(jid);
    if (!parsed) {
      logger.warn({ jid }, 'Teams: invalid JID format');
      return;
    }

    if (!this.connected || !this.graphClient) {
      this.outgoingQueue.push({ jid, text, sender });
      logger.info(
        { jid, queueSize: this.outgoingQueue.length },
        'Teams disconnected, message queued',
      );
      return;
    }

    // When sender is provided, prefix the message with the role name
    // (Graph API doesn't support display name overrides like Slack)
    const content = sender ? `**[${sender}]** ${text}` : text;

    try {
      const chunks =
        content.length <= MAX_MESSAGE_LENGTH
          ? [content]
          : Array.from(
              { length: Math.ceil(content.length / MAX_MESSAGE_LENGTH) },
              (_, i) =>
                content.slice(
                  i * MAX_MESSAGE_LENGTH,
                  (i + 1) * MAX_MESSAGE_LENGTH,
                ),
            );

      for (const chunk of chunks) {
        await this.graphClient
          .api(
            `/teams/${parsed.teamId}/channels/${parsed.channelId}/messages`,
          )
          .post({
            body: { contentType: 'text', content: chunk },
          });
      }
      logger.info({ jid, length: text.length, sender }, 'Teams message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text, sender });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Teams message, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('teams:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.graphClient = null;
    this.msalClient = null;
    logger.info('Teams channel stopped');
  }

  // Graph API doesn't support typing indicators in polling mode
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op: Graph API has no typing indicator endpoint for channel messages
  }

  async syncGroups(force: boolean): Promise<void> {
    if (!this.graphClient) return;

    try {
      logger.info('Syncing team/channel metadata from Teams...');
      let count = 0;

      const teamsResponse = await this.graphClient
        .api('/me/joinedTeams')
        .get();
      const teams = teamsResponse.value || [];

      for (const team of teams) {
        if (!team.id || !team.displayName) continue;

        const channelsResponse = await this.graphClient
          .api(`/teams/${team.id}/channels`)
          .get();
        const channels = channelsResponse.value || [];

        for (const channel of channels) {
          if (!channel.id || !channel.displayName) continue;

          const jid = `teams:${team.id}:${channel.id}`;
          const name = `${team.displayName} / ${channel.displayName}`;
          updateChatName(jid, name);

          this.opts.onChatMetadata(
            jid,
            new Date().toISOString(),
            name,
            'teams',
            true,
          );
          count++;
        }
      }

      logger.info({ count }, 'Teams channel metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync Teams channel metadata');
    }
  }

  // --- Private ---

  private schedulePoll(): void {
    const backoffMs =
      this.consecutiveErrors > 0
        ? Math.min(
            this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
            30 * 60 * 1000,
          )
        : this.pollIntervalMs;

    this.pollTimer = setTimeout(() => {
      this.pollForMessages()
        .catch((err) => logger.error({ err }, 'Teams poll error'))
        .finally(() => {
          if (this.connected) this.schedulePoll();
        });
    }, backoffMs);
  }

  private async pollForMessages(): Promise<void> {
    if (!this.graphClient) return;

    const groups = this.opts.registeredGroups();
    const teamsGroups = Object.entries(groups).filter(([jid]) =>
      jid.startsWith('teams:'),
    );

    if (teamsGroups.length === 0) {
      this.consecutiveErrors = 0;
      return;
    }

    try {
      for (const [jid] of teamsGroups) {
        await this.pollChannel(jid);
      }
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        { err, consecutiveErrors: this.consecutiveErrors, nextPollMs: backoffMs },
        'Teams poll failed',
      );
    }
  }

  private async pollChannel(jid: string): Promise<void> {
    if (!this.graphClient) return;

    const parsed = this.parseJid(jid);
    if (!parsed) return;

    const channelKey = `${parsed.teamId}:${parsed.channelId}`;
    const deltaToken = this.deltaTokens.get(channelKey);

    let url: string;
    if (deltaToken) {
      url = deltaToken;
    } else {
      url = `/teams/${parsed.teamId}/channels/${parsed.channelId}/messages/delta`;
    }

    try {
      const response = deltaToken
        ? await this.graphClient.api(url).get()
        : await this.graphClient.api(url).get();

      const messages = response.value || [];

      for (const msg of messages) {
        await this.processTeamsMessage(jid, msg);
      }

      // Store the delta link for next poll
      const nextDeltaLink =
        response['@odata.deltaLink'] || response['@odata.nextLink'];
      if (nextDeltaLink) {
        this.deltaTokens.set(channelKey, nextDeltaLink);
      }
    } catch (err: unknown) {
      // If delta token is stale, reset and try fresh
      if (
        deltaToken &&
        err instanceof Error &&
        'statusCode' in err &&
        (err as { statusCode: number }).statusCode === 410
      ) {
        logger.warn(
          { channelKey },
          'Teams delta token expired, resetting',
        );
        this.deltaTokens.delete(channelKey);
      } else {
        throw err;
      }
    }
  }

  private async processTeamsMessage(
    jid: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    // Skip messages without body content
    const body = msg.body as { content?: string; contentType?: string } | undefined;
    if (!body?.content) return;

    // Skip deleted messages
    if (msg.deletedDateTime) return;

    // Get sender info
    const from = msg.from as {
      user?: { id?: string; displayName?: string };
    } | undefined;
    const senderId = from?.user?.id || '';
    const senderName = from?.user?.displayName || 'unknown';

    // Skip own messages
    if (senderId === this.botUserId) return;

    // Cache user names
    if (senderId && senderName !== 'unknown') {
      this.userNameCache.set(senderId, senderName);
    }

    const timestamp = msg.createdDateTime
      ? new Date(msg.createdDateTime as string).toISOString()
      : new Date().toISOString();

    const messageId = (msg.id as string) || timestamp;

    // Always report metadata
    this.opts.onChatMetadata(jid, timestamp, undefined, 'teams', true);

    // Translate <at>...</at> mentions into trigger format
    let content = body.content;

    // Strip HTML tags if contentType is html
    if (body.contentType === 'html') {
      // Extract text from <at> tags before stripping all HTML
      const atMentionRegex = /<at[^>]*>([^<]*)<\/at>/gi;
      const mentions: string[] = [];
      let match;
      while ((match = atMentionRegex.exec(content)) !== null) {
        mentions.push(match[1]);
      }

      // Strip all HTML tags
      content = content.replace(/<[^>]+>/g, '').trim();

      // If any mention matches the bot display name and trigger doesn't already match
      if (
        mentions.length > 0 &&
        !TRIGGER_PATTERN.test(content)
      ) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    if (!content) return;

    this.opts.onMessage(jid, {
      id: messageId,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private parseJid(
    jid: string,
  ): { teamId: string; channelId: string } | null {
    const match = jid.match(/^teams:([^:]+):(.+)$/);
    if (!match) return null;
    return { teamId: match[1], channelId: match[2] };
  }

  private async acquireToken(
    credentials: StoredCredentials,
  ): Promise<AuthenticationResult | null> {
    if (!this.msalClient) return null;

    try {
      if (credentials.refresh_token) {
        const result = await this.msalClient.acquireTokenByRefreshToken({
          refreshToken: credentials.refresh_token,
          scopes: [
            'https://graph.microsoft.com/ChannelMessage.Read.All',
            'https://graph.microsoft.com/ChannelMessage.Send',
            'https://graph.microsoft.com/Team.ReadBasic.All',
            'https://graph.microsoft.com/Channel.ReadBasic.All',
            'https://graph.microsoft.com/User.Read',
          ],
        });

        if (result) {
          this.persistTokens(result);
          return result;
        }
      }

      logger.error(
        'Teams: no refresh token available. Re-run /add-teams setup.',
      );
      return null;
    } catch (err) {
      logger.error({ err }, 'Teams: failed to acquire token');
      return null;
    }
  }

  private async getAccessToken(): Promise<string> {
    if (!this.msalClient) throw new Error('Teams: MSAL client not initialized');

    const credentials: StoredCredentials = JSON.parse(
      fs.readFileSync(CREDENTIALS_PATH, 'utf-8'),
    );

    const result = await this.acquireToken(credentials);
    if (!result?.accessToken) {
      throw new Error('Teams: failed to refresh access token');
    }

    return result.accessToken;
  }

  private persistTokens(result: AuthenticationResult): void {
    try {
      const existing: StoredCredentials = fs.existsSync(CREDENTIALS_PATH)
        ? JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'))
        : {};

      const updated: StoredCredentials = {
        ...existing,
        access_token: result.accessToken,
        expires_on: result.expiresOn
          ? Math.floor(result.expiresOn.getTime() / 1000)
          : undefined,
      };

      // MSAL doesn't expose refresh tokens in acquireTokenByRefreshToken results,
      // so only update if we actually got a new one
      if ((result as Record<string, unknown>).refreshToken) {
        updated.refresh_token = (result as Record<string, unknown>).refreshToken as string;
      }

      fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(updated, null, 2));
      logger.debug('Teams OAuth tokens refreshed');
    } catch (err) {
      logger.warn({ err }, 'Failed to persist refreshed Teams tokens');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0 || !this.graphClient) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing Teams outgoing queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        const parsed = this.parseJid(item.jid);
        if (!parsed) continue;
        const content = item.sender
          ? `**[${item.sender}]** ${item.text}`
          : item.text;
        await this.graphClient
          .api(`/teams/${parsed.teamId}/channels/${parsed.channelId}/messages`)
          .post({ body: { contentType: 'text', content } });
        logger.info(
          { jid: item.jid, length: item.text.length, sender: item.sender },
          'Queued Teams message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('teams', (opts: ChannelOpts) => {
  if (
    !fs.existsSync(OAUTH_CONFIG_PATH) ||
    !fs.existsSync(CREDENTIALS_PATH)
  ) {
    logger.warn('Teams: credentials not found in ~/.teams-mcp/');
    return null;
  }
  return new TeamsChannel(opts);
});
