# Intent: Add Teams channel import

Add `import './teams.js';` to the channel barrel file so the Teams
module self-registers with the channel registry on startup.

This is an append-only change — existing import lines for other channels
must be preserved.
