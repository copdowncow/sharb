#!/bin/sh

# Start Node.js server in background
node server.js &
NODE_PID=$!

# Wait until Node is actually ready on port 3000
echo "Waiting for Node.js to be ready..."
i=0
while ! nc -z localhost 3000 2>/dev/null; do
  sleep 0.2
  i=$((i + 1))
  if [ $i -gt 25 ]; then
    echo "ERROR: Node.js did not start in time"
    exit 1
  fi
done

echo "Node.js is ready, starting Caddy..."

# Start Caddy in foreground
exec caddy run --config Caddyfile
