#!/bin/sh
# migrate → seed → start. Any failing step stops the container before the API listens.
set -e

node dist/scripts/migrate.js
node dist/scripts/seed.js
exec node dist/server.js
