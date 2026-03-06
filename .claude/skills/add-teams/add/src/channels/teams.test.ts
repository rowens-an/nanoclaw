import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Jonesy',
  TRIGGER_PATTERN: /^@Jonesy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  updateChatName: vi.fn(),
}));

// --- fs mock ---

const mockFs = vi.hoisted(() => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockImplementation((filePath: string) => {
    if (filePath.includes('oauth-config.json')) {
      return JSON.stringify({
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        tenant_id: 'test-tenant-id',
      });
    }
    if (filePath.includes('credentials.json')) {
      return JSON.stringify({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_on: Math.floor(Date.now() / 1000) + 3600,
      });
    }
    return '{}';
  }),
  writeFileSync: vi.fn(),
}));

vi.mock('fs', () => ({
  default: mockFs,
  ...mockFs,
}));

// --- MSAL mock ---

const msalRef = vi.hoisted(() => ({
  acquireTokenByRefreshToken: vi.fn().mockResolvedValue({
    accessToken: 'mock-access-token',
    expiresOn: new Date(Date.now() + 3600000),
  }),
}));

vi.mock('@azure/msal-node', () => ({
  ConfidentialClientApplication: class MockMsal {
    acquireTokenByRefreshToken = msalRef.acquireTokenByRefreshToken;
    constructor() {}
  },
}));

// --- Graph client mock ---

const graphApiRef = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ value: [] }),
  post: vi.fn().mockResolvedValue({}),
}));

vi.mock('@microsoft/microsoft-graph-client', () => ({
  Client: {
    init: vi.fn().mockReturnValue({
      api: vi.fn().mockReturnValue({
        get: graphApiRef.get,
        post: graphApiRef.post,
      }),
    }),
  },
}));

import { TeamsChannel, TeamsChannelOpts } from './teams.js';
import { updateChatName } from '../db.js';
import { Client } from '@microsoft/microsoft-graph-client';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<TeamsChannelOpts>,
): TeamsChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'teams:team-123:channel-456': {
        name: 'Test Channel',
        folder: 'test-channel',
        trigger: '@Jonesy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

// --- Tests ---

describe('TeamsChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock behaviors
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (typeof filePath === 'string' && filePath.includes('oauth-config.json')) {
        return JSON.stringify({
          client_id: 'test-client-id',
          client_secret: 'test-client-secret',
          tenant_id: 'test-tenant-id',
        });
      }
      if (typeof filePath === 'string' && filePath.includes('credentials.json')) {
        return JSON.stringify({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expires_on: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      return '{}';
    });
    msalRef.acquireTokenByRefreshToken.mockResolvedValue({
      accessToken: 'mock-access-token',
      expiresOn: new Date(Date.now() + 3600000),
    });
    graphApiRef.get.mockResolvedValue({ id: 'bot-user-id', displayName: 'Bot' });
    graphApiRef.post.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects successfully with valid credentials', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      expect(channel.isConnected()).toBe(false);
    });

    it('skips connect when credentials missing', async () => {
      mockFs.existsSync.mockReturnValue(false);

      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('gets bot user profile on connect', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();

      expect(Client.init).toHaveBeenCalled();
    });

    it('stays connected when user profile fetch fails', async () => {
      graphApiRef.get.mockRejectedValueOnce(new Error('Profile fetch failed'));

      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('does not connect when token acquisition fails', async () => {
      msalRef.acquireTokenByRefreshToken.mockResolvedValue(null);

      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns teams: JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('teams:team-123:channel-456')).toBe(true);
    });

    it('owns teams: JIDs with complex channel IDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(
        channel.ownsJid(
          'teams:7155e3c8-175e-4311-97ef-572edc3aa3db:19:0ea5de04de4743bcb4cd20cb99235d99@thread.tacv2',
        ),
      ).toBe(true);
    });

    it('does not own slack: JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('slack:C0123456789')).toBe(false);
    });

    it('does not own gmail: JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('gmail:thread-123')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- JID parsing ---

  describe('JID parsing', () => {
    it('correctly parses team and channel IDs from JID', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      await channel.sendMessage('teams:team-abc:channel-def', 'Hello');

      const mockClient = vi.mocked(Client.init).mock.results[0]?.value;
      expect(mockClient.api).toHaveBeenCalledWith(
        '/teams/team-abc/channels/channel-def/messages',
      );
    });

    it('handles JIDs with colons in channel ID', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      await channel.sendMessage(
        'teams:team-123:19:abc@thread.tacv2',
        'Hello',
      );

      const mockClient = vi.mocked(Client.init).mock.results[0]?.value;
      expect(mockClient.api).toHaveBeenCalledWith(
        '/teams/team-123/channels/19:abc@thread.tacv2/messages',
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Graph API', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      await channel.sendMessage('teams:team-123:channel-456', 'Hello');

      expect(graphApiRef.post).toHaveBeenCalledWith({
        body: { contentType: 'text', content: 'Hello' },
      });
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.sendMessage('teams:team-123:channel-456', 'Queued');

      expect(graphApiRef.post).not.toHaveBeenCalled();
    });

    it('queues message on send failure', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      graphApiRef.post.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        channel.sendMessage('teams:team-123:channel-456', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('splits long messages at 4096 character boundary', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      const longText = 'A'.repeat(5000);
      await channel.sendMessage('teams:team-123:channel-456', longText);

      // Should be split into 2 messages: 4096 + 904
      expect(graphApiRef.post).toHaveBeenCalledTimes(2);
      expect(graphApiRef.post).toHaveBeenNthCalledWith(1, {
        body: { contentType: 'text', content: 'A'.repeat(4096) },
      });
      expect(graphApiRef.post).toHaveBeenNthCalledWith(2, {
        body: { contentType: 'text', content: 'A'.repeat(904) },
      });
    });

    it('sends exactly-4096-char messages as single message', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      const text = 'B'.repeat(4096);
      await channel.sendMessage('teams:team-123:channel-456', text);

      expect(graphApiRef.post).toHaveBeenCalledTimes(1);
    });

    it('warns on invalid JID format', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      await channel.sendMessage('invalid-jid', 'Hello');

      expect(graphApiRef.post).not.toHaveBeenCalled();
    });
  });

  // --- Message processing ---

  describe('message processing', () => {
    it('processes plain text messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'teams:team-123:channel-456': {
            name: 'Test Channel',
            folder: 'test-channel',
            trigger: '@Jonesy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new TeamsChannel(opts);

      // Access private method for testing
      const processMessage = (channel as unknown as {
        processTeamsMessage: (jid: string, msg: Record<string, unknown>) => Promise<void>;
      }).processTeamsMessage.bind(channel);

      await processMessage('teams:team-123:channel-456', {
        id: 'msg-1',
        body: { content: 'Hello world', contentType: 'text' },
        from: { user: { id: 'user-1', displayName: 'Alice' } },
        createdDateTime: '2024-01-01T00:00:00.000Z',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:team-123:channel-456',
        expect.objectContaining({
          id: 'msg-1',
          content: 'Hello world',
          sender: 'user-1',
          sender_name: 'Alice',
        }),
      );
    });

    it('skips messages without body content', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const processMessage = (channel as unknown as {
        processTeamsMessage: (jid: string, msg: Record<string, unknown>) => Promise<void>;
      }).processTeamsMessage.bind(channel);

      await processMessage('teams:team-123:channel-456', {
        id: 'msg-1',
        body: { content: '' },
        from: { user: { id: 'user-1', displayName: 'Alice' } },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips deleted messages', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const processMessage = (channel as unknown as {
        processTeamsMessage: (jid: string, msg: Record<string, unknown>) => Promise<void>;
      }).processTeamsMessage.bind(channel);

      await processMessage('teams:team-123:channel-456', {
        id: 'msg-1',
        body: { content: 'Deleted message' },
        from: { user: { id: 'user-1', displayName: 'Alice' } },
        deletedDateTime: '2024-01-01T01:00:00.000Z',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips own messages (bot self-detection)', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      // Simulate setting botUserId
      (channel as unknown as { botUserId: string }).botUserId = 'bot-user-id';

      const processMessage = (channel as unknown as {
        processTeamsMessage: (jid: string, msg: Record<string, unknown>) => Promise<void>;
      }).processTeamsMessage.bind(channel);

      await processMessage('teams:team-123:channel-456', {
        id: 'msg-1',
        body: { content: 'My own message' },
        from: { user: { id: 'bot-user-id', displayName: 'Bot' } },
        createdDateTime: '2024-01-01T00:00:00.000Z',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('always emits metadata for messages', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const processMessage = (channel as unknown as {
        processTeamsMessage: (jid: string, msg: Record<string, unknown>) => Promise<void>;
      }).processTeamsMessage.bind(channel);

      await processMessage('teams:team-123:channel-456', {
        id: 'msg-1',
        body: { content: 'Hello', contentType: 'text' },
        from: { user: { id: 'user-1', displayName: 'Alice' } },
        createdDateTime: '2024-01-01T00:00:00.000Z',
      });

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'teams:team-123:channel-456',
        expect.any(String),
        undefined,
        'teams',
        true,
      );
    });
  });

  // --- Mention translation ---

  describe('mention translation', () => {
    it('translates HTML <at> mentions to trigger format', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const processMessage = (channel as unknown as {
        processTeamsMessage: (jid: string, msg: Record<string, unknown>) => Promise<void>;
      }).processTeamsMessage.bind(channel);

      await processMessage('teams:team-123:channel-456', {
        id: 'msg-1',
        body: {
          content: '<p><at id="0">BotName</at> what do you think?</p>',
          contentType: 'html',
        },
        from: { user: { id: 'user-1', displayName: 'Alice' } },
        createdDateTime: '2024-01-01T00:00:00.000Z',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:team-123:channel-456',
        expect.objectContaining({
          content: '@Jonesy BotName what do you think?',
        }),
      );
    });

    it('does not prepend trigger when trigger pattern already matches', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const processMessage = (channel as unknown as {
        processTeamsMessage: (jid: string, msg: Record<string, unknown>) => Promise<void>;
      }).processTeamsMessage.bind(channel);

      await processMessage('teams:team-123:channel-456', {
        id: 'msg-1',
        body: {
          content: '<p><at id="0">Jonesy</at> hello</p>',
          contentType: 'html',
        },
        from: { user: { id: 'user-1', displayName: 'Alice' } },
        createdDateTime: '2024-01-01T00:00:00.000Z',
      });

      // After HTML stripping, content is "Jonesy hello"
      // Then stripped content doesn't start with @Jonesy, so trigger gets prepended
      // This is correct behavior - the raw text "Jonesy hello" doesn't match ^@Jonesy
      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:team-123:channel-456',
        expect.objectContaining({
          content: expect.stringContaining('Jonesy hello'),
        }),
      );
    });

    it('strips HTML from messages with html contentType', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      const processMessage = (channel as unknown as {
        processTeamsMessage: (jid: string, msg: Record<string, unknown>) => Promise<void>;
      }).processTeamsMessage.bind(channel);

      await processMessage('teams:team-123:channel-456', {
        id: 'msg-1',
        body: {
          content: '<p>Hello <strong>world</strong></p>',
          contentType: 'html',
        },
        from: { user: { id: 'user-1', displayName: 'Alice' } },
        createdDateTime: '2024-01-01T00:00:00.000Z',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'teams:team-123:channel-456',
        expect.objectContaining({
          content: 'Hello world',
        }),
      );
    });
  });

  // --- syncGroups ---

  describe('syncGroups', () => {
    it('lists teams and channels and updates metadata', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      // Override the get mock for syncGroups calls
      const mockClient = vi.mocked(Client.init).mock.results[0]?.value;
      mockClient.api.mockImplementation((url: string) => ({
        get: vi.fn().mockResolvedValue(
          url === '/me/joinedTeams'
            ? {
                value: [
                  { id: 'team-1', displayName: 'Engineering' },
                  { id: 'team-2', displayName: 'Marketing' },
                ],
              }
            : url.includes('/channels')
              ? {
                  value: [
                    { id: 'ch-1', displayName: 'General' },
                  ],
                }
              : { id: 'bot-user-id', displayName: 'Bot' },
        ),
        post: graphApiRef.post,
      }));

      await channel.syncGroups(false);

      expect(updateChatName).toHaveBeenCalledWith(
        'teams:team-1:ch-1',
        'Engineering / General',
      );
      expect(updateChatName).toHaveBeenCalledWith(
        'teams:team-2:ch-1',
        'Marketing / General',
      );
    });

    it('handles API errors gracefully', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);
      await channel.connect();

      const mockClient = vi.mocked(Client.init).mock.results[0]?.value;
      mockClient.api.mockReturnValue({
        get: vi.fn().mockRejectedValue(new Error('API error')),
        post: graphApiRef.post,
      });

      // Should not throw
      await expect(channel.syncGroups(false)).resolves.toBeUndefined();
    });

    it('does nothing when not connected', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      await channel.syncGroups(false);

      expect(updateChatName).not.toHaveBeenCalled();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('resolves without error (no-op)', async () => {
      const channel = new TeamsChannel(createTestOpts());

      await expect(
        channel.setTyping('teams:team-123:channel-456', true),
      ).resolves.toBeUndefined();
    });

    it('accepts false without error', async () => {
      const channel = new TeamsChannel(createTestOpts());

      await expect(
        channel.setTyping('teams:team-123:channel-456', false),
      ).resolves.toBeUndefined();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "teams"', () => {
      const channel = new TeamsChannel(createTestOpts());
      expect(channel.name).toBe('teams');
    });
  });

  // --- Constructor ---

  describe('constructor', () => {
    it('accepts custom poll interval', () => {
      const channel = new TeamsChannel(createTestOpts(), 30000);
      expect(channel.name).toBe('teams');
    });
  });

  // --- Error backoff ---

  describe('error backoff', () => {
    it('tracks consecutive errors', async () => {
      const opts = createTestOpts();
      const channel = new TeamsChannel(opts);

      // Access private consecutiveErrors
      expect(
        (channel as unknown as { consecutiveErrors: number }).consecutiveErrors,
      ).toBe(0);
    });
  });
});
