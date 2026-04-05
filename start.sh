#!/bin/sh
# Start Node.js server in background
node server.js &

# Wait a moment for Node to boot
sleep 1

# Start Caddy (foreground, reads Caddyfile)
caddy run --config Caddyfile
