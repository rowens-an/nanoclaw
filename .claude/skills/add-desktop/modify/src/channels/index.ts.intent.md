# Intent: Add Desktop channel import

Add `import './desktop.js';` to the channel barrel file so the Desktop
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
