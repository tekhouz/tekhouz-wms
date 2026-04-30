#!/bin/bash
# Double-click this file in Finder to start the server

export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"

cd "$(dirname "$0")"

echo "Starting RefurbTracker..."
echo "Open your browser at: http://localhost:3000"
echo "Login: admin / admin123"
echo ""
echo "Press Ctrl+C to stop the server"
echo "-----------------------------------"

node server.js
