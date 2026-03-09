import http from 'http';
import { randomUUID } from 'crypto';

import { WebSocketServer, WebSocket } from 'ws';

import { ASSISTANT_NAME } from '../config.js';
import { getAllMessages, storeMessage, updateChatName } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

interface WSInboundMessage {
  type: 'message';
  groupJid: string;
  content: string;
  id: string;
}

interface WSOutboundMessage {
  type: 'message';
  groupJid: string;
  content: string;
  sender: string;
  timestamp: string;
  id: string;
}

interface WSTypingMessage {
  type: 'typing';
  groupJid: string;
  isTyping: boolean;
}

export class DesktopChannel implements Channel {
  name = 'desktop';

  private server: http.Server;
  private wss: WebSocketServer;
  private port: number;
  private authToken: string | undefined;
  private connected = false;
  private clients = new Set<WebSocket>();

  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;

  constructor(opts: ChannelOpts, port: number, authToken?: string) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.port = port;
    this.authToken = authToken;

    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on('upgrade', (req, socket, head) => {
      if (!this.authenticate(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (req.url?.startsWith('/ws')) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logger.info('Desktop client connected');

      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WSInboundMessage;
          if (msg.type === 'message') {
            this.handleInboundMessage(msg);
          }
        } catch (err) {
          logger.warn({ err }, 'Invalid desktop WebSocket message');
        }
      });

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info('Desktop client disconnected');
      });
    });
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        this.connected = true;
        logger.info(
          { port: this.port },
          `Desktop channel listening on 127.0.0.1:${this.port}`,
        );
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  async sendMessage(jid: string, text: string, sender?: string): Promise<void> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const senderName = sender || ASSISTANT_NAME;

    // Store bot message in DB so history is complete
    storeMessage({
      id,
      chat_jid: jid,
      sender: 'assistant',
      sender_name: senderName,
      content: text,
      timestamp: now,
      is_from_me: true,
      is_bot_message: true,
    });

    const frame: WSOutboundMessage = {
      type: 'message',
      groupJid: jid,
      content: text,
      sender: senderName,
      timestamp: now,
      id,
    };

    this.broadcast(jid, frame);
    logger.info({ jid, length: text.length, sender: senderName }, 'Desktop message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('desktop:');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const frame: WSTypingMessage = { type: 'typing', groupJid: jid, isTyping };
    this.broadcast(jid, frame);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleInboundMessage(msg: WSInboundMessage): void {
    const groups = this.registeredGroups();
    if (!groups[msg.groupJid]) {
      logger.warn({ groupJid: msg.groupJid }, 'Desktop message for unregistered group');
      return;
    }

    const now = new Date().toISOString();

    this.onChatMetadata(msg.groupJid, now, undefined, 'desktop', true);

    this.onMessage(msg.groupJid, {
      id: msg.id || randomUUID(),
      chat_jid: msg.groupJid,
      sender: 'desktop-user',
      sender_name: 'User',
      content: msg.content,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS headers for local development
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!this.authenticate(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;

    if (pathname === '/api/status' && req.method === 'GET') {
      this.handleStatus(res);
    } else if (pathname === '/api/groups' && req.method === 'GET') {
      this.handleListGroups(res);
    } else if (pathname === '/api/groups' && req.method === 'POST') {
      this.handleCreateGroup(req, res);
    } else if (pathname.match(/^\/api\/groups\/[^/]+$/) && req.method === 'DELETE') {
      const jid = decodeURIComponent(pathname.split('/').pop()!);
      this.handleDeleteGroup(jid, res);
    } else if (pathname.match(/^\/api\/groups\/[^/]+\/messages$/) && req.method === 'GET') {
      const parts = pathname.split('/');
      const jid = decodeURIComponent(parts[parts.length - 2]);
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      this.handleGetMessages(jid, limit, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private handleStatus(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: this.connected,
      assistantName: ASSISTANT_NAME,
      clients: this.clients.size,
    }));
  }

  private handleListGroups(res: http.ServerResponse): void {
    const groups = this.registeredGroups();
    const desktopGroups = Object.entries(groups)
      .filter(([jid]) => jid.startsWith('desktop:'))
      .map(([jid, g]) => ({ jid, name: g.name, folder: g.folder, addedAt: g.added_at }));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(desktopGroups));
  }

  private handleCreateGroup(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { name } = JSON.parse(body) as { name: string };
        if (!name || typeof name !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'name is required' }));
          return;
        }

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        if (!slug) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid group name' }));
          return;
        }

        const jid = `desktop:${slug}`;
        const groups = this.registeredGroups();
        if (groups[jid]) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Group already exists', jid }));
          return;
        }

        // Store chat metadata so it shows up in the system
        updateChatName(jid, name);
        this.onChatMetadata(jid, new Date().toISOString(), name, 'desktop', true);

        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jid,
          name,
          folder: `desktop-${slug}`,
          message: 'Group created. Register it via IPC or the main channel to start using it.',
        }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  private handleDeleteGroup(jid: string, res: http.ServerResponse): void {
    // Only report desktop groups
    if (!jid.startsWith('desktop:')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not a desktop group' }));
      return;
    }

    // We don't actually delete from DB here — that's handled by the orchestrator.
    // This endpoint is for the app to signal intent.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: jid }));
  }

  private handleGetMessages(jid: string, limit: number, res: http.ServerResponse): void {
    if (!jid.startsWith('desktop:')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not a desktop group' }));
      return;
    }

    const messages = getAllMessages(jid, Math.min(limit, 1000));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(messages));
  }

  private authenticate(req: http.IncomingMessage): boolean {
    if (!this.authToken) return true;

    const authHeader = req.headers.authorization;
    if (authHeader === `Bearer ${this.authToken}`) return true;

    // Check query param for WebSocket upgrades
    const url = new URL(req.url || '/', `http://127.0.0.1:${this.port}`);
    const token = url.searchParams.get('token');
    return token === this.authToken;
  }

  private broadcast(groupJid: string, frame: WSOutboundMessage | WSTypingMessage): void {
    const data = JSON.stringify(frame);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }
}

registerChannel('desktop', (opts: ChannelOpts) => {
  const env = readEnvFile(['DESKTOP_ENABLED', 'DESKTOP_PORT', 'DESKTOP_AUTH_TOKEN']);
  if (env.DESKTOP_ENABLED !== 'true') return null;
  const port = parseInt(env.DESKTOP_PORT || '19280', 10);
  return new DesktopChannel(opts, port, env.DESKTOP_AUTH_TOKEN);
});
