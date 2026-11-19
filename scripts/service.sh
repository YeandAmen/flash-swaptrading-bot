#!/usr/bin/env bash
# Manage the bot as a macOS LaunchAgent: starts at login, restarts on crash. (The bot keeps the Mac awake via caffeinate.)
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
LABEL="com.local.eth-token-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
NODE="$(command -v node)"
PORT="$(grep -E '^PORT=' .env 2>/dev/null | cut -d= -f2- || true)"; PORT="${PORT:-7777}"
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

case "${1:-}" in
  install)
    npm run build >/dev/null
    mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$DIR/dist/server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$DIR")</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$(xml "$(dirname "$NODE")"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$DIR/data/server.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$DIR/data/server.log")</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    for _ in $(seq 1 40); do launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break; sleep 1; done
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed and started. Dashboard: http://localhost:$PORT"
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Stopped and removed the LaunchAgent. (Wallet key stays in your Keychain.)"
    ;;
  restart)
    npm run build >/dev/null
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "Restarted."
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code)' || echo "Not installed."
    curl -s -m 3 "http://127.0.0.1:$PORT/api/state" >/dev/null && echo "Dashboard reachable: http://localhost:$PORT" || echo "Dashboard not reachable yet."
    ;;
  logs)
    tail -n 60 "$DIR/data/server.log"
    ;;
  *)
    echo "usage: $0 install|uninstall|restart|status|logs"; exit 1;;
esac
