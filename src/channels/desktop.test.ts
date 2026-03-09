import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import http from 'http';

import { _initTestDatabase, getAllMessages, storeChatMetadata } from '../db.js';
import { DesktopChannel } from './desktop.js';

function makeOpts() {
  const messages: Array<{ jid: string; msg: unknown }> = [];
  const metadata: Array<{ jid: string; timestamp: string }> = [];
  const groups: Record<string, { name: string; folder: string; trigger: string; added_at: string }> = {};

  return {
    opts: {
      onMessage: (jid: string, msg: unknown) => messages.push({ jid, msg }),
      onChatMetadata: (jid: string, timestamp: string) => metadata.push({ jid, timestamp }),
      registeredGroups: () => groups,
    },
    messages,
    metadata,
    groups,
  };
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method, headers: { Connection: 'close', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    if (body) {
      req.setHeader('Content-Type', 'application/json');
      req.write(body);
    }
    req.end();
  });
}

describe('DesktopChannel', () => {
  const port = 19281;
  let channel: DesktopChannel;

  beforeEach(async () => {
    _initTestDatabase();
    const { opts } = makeOpts();
    channel = new DesktopChannel(opts, port);
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  it('reports connected after connect', () => {
    expect(channel.isConnected()).toBe(true);
  });

  it('owns desktop: JIDs', () => {
    expect(channel.ownsJid('desktop:test')).toBe(true);
    expect(channel.ownsJid('slack:C123')).toBe(false);
    expect(channel.ownsJid('whatsapp:123@g.us')).toBe(false);
  });

  it('GET /api/status returns status', async () => {
    const res = await httpRequest(port, 'GET', '/api/status');
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.connected).toBe(true);
    expect(data.assistantName).toBeTruthy();
  });

  it('GET /api/groups returns empty initially', async () => {
    const res = await httpRequest(port, 'GET', '/api/groups');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('POST /api/groups creates a group', async () => {
    const res = await httpRequest(port, 'POST', '/api/groups', JSON.stringify({ name: 'Test Project' }));
    expect(res.status).toBe(201);
    const data = JSON.parse(res.body);
    expect(data.jid).toBe('desktop:test-project');
    expect(data.name).toBe('Test Project');
  });

  it('POST /api/groups rejects duplicate', async () => {
    const { opts, groups } = makeOpts();
    await channel.disconnect();
    groups['desktop:test'] = { name: 'Test', folder: 'desktop-test', trigger: '@NanoClaude', added_at: '' };
    channel = new DesktopChannel(opts, port);
    await channel.connect();

    const res = await httpRequest(port, 'POST', '/api/groups', JSON.stringify({ name: 'Test' }));
    expect(res.status).toBe(409);
  });

  it('POST /api/groups rejects empty name', async () => {
    const res = await httpRequest(port, 'POST', '/api/groups', JSON.stringify({ name: '' }));
    expect(res.status).toBe(400);
  });

  it('GET /api/groups/:jid/messages returns messages', async () => {
    const res = await httpRequest(port, 'GET', '/api/groups/desktop:test/messages');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('sendMessage stores bot message in DB', async () => {
    // Create chat record first (FK constraint)
    storeChatMetadata('desktop:test', new Date().toISOString(), 'Test', 'desktop', true);
    await channel.sendMessage('desktop:test', 'Hello from bot');
    const messages = getAllMessages('desktop:test');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Hello from bot');
    expect(messages[0].is_bot_message).toBeTruthy();
  });

  it('returns 404 for unknown routes', async () => {
    const res = await httpRequest(port, 'GET', '/api/unknown');
    expect(res.status).toBe(404);
  });

  it('reports disconnected after disconnect', async () => {
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
    // Reconnect for afterEach
    const { opts } = makeOpts();
    channel = new DesktopChannel(opts, port);
    await channel.connect();
  });
});

describe('DesktopChannel auth', () => {
  const port = 19282;
  let channel: DesktopChannel;

  beforeEach(async () => {
    _initTestDatabase();
    const { opts } = makeOpts();
    channel = new DesktopChannel(opts, port, 'test-secret');
    await channel.connect();
  });

  afterEach(async () => {
    await channel.disconnect();
  });

  it('rejects requests without auth token', async () => {
    const res = await httpRequest(port, 'GET', '/api/status');
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct Bearer token', async () => {
    const res = await httpRequest(port, 'GET', '/api/status', undefined, {
      Authorization: 'Bearer test-secret',
    });
    expect(res.status).toBe(200);
  });

  it('rejects requests with wrong token', async () => {
    const res = await httpRequest(port, 'GET', '/api/status', undefined, {
      Authorization: 'Bearer wrong',
    });
    expect(res.status).toBe(401);
  });
});
