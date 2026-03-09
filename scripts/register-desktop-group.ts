#!/usr/bin/env npx tsx
/**
 * Register a desktop group directly in the DB.
 * Usage: npx tsx scripts/register-desktop-group.ts "My Project"
 */
import { initDatabase, setRegisteredGroup, storeChatMetadata } from '../src/db.js';
import { resolveGroupFolderPath } from '../src/group-folder.js';
import { ASSISTANT_NAME } from '../src/config.js';
import fs from 'fs';
import path from 'path';

const name = process.argv[2];
if (!name) {
  console.error('Usage: npx tsx scripts/register-desktop-group.ts "Group Name"');
  process.exit(1);
}

const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const jid = `desktop:${slug}`;
const folder = `desktop-${slug}`;

initDatabase();

// Create chat metadata
storeChatMetadata(jid, new Date().toISOString(), name, 'desktop', true);

// Register group
setRegisteredGroup(jid, {
  name,
  folder,
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});

// Create group directory
const groupDir = resolveGroupFolderPath(folder);
fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

console.log(`Registered desktop group:`);
console.log(`  JID:    ${jid}`);
console.log(`  Folder: ${folder}`);
console.log(`  Path:   ${groupDir}`);
console.log(`\nRestart NanoClaw to pick it up: npm run dev`);
