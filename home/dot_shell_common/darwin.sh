#!/bin/sh
# Common macOS-specific configuration for all shells

# Homebrew setup
if [ -f /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
elif [ -f /usr/local/bin/brew ]; then
  eval "$(/usr/local/bin/brew shellenv)"
fi

# 1Password SSH agent
# https://developer.1password.com/docs/ssh/get-started/
if [ -S "$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" ]; then
  export SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
fi

# 1Password SSH LaunchAgent setup (run once)
if [ -d "$HOME/Library/Group Containers/2BUA8C4S2C.com.1password" ] && [ ! -f ~/Library/LaunchAgents/com.1password.SSH_AUTH_SOCK.plist ]; then
  mkdir -p ~/Library/LaunchAgents
  cat << 'EOF' > ~/Library/LaunchAgents/com.1password.SSH_AUTH_SOCK.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.1password.SSH_AUTH_SOCK</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>/bin/ln -sf $HOME/Library/Group\ Containers/2BUA8C4S2C.com.1password/t/agent.sock $SSH_AUTH_SOCK</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
EOF
  launchctl load -w ~/Library/LaunchAgents/com.1password.SSH_AUTH_SOCK.plist
fi

# macOS specific aliases
alias showfiles='defaults write com.apple.finder AppleShowAllFiles YES; killall Finder'
alias hidefiles='defaults write com.apple.finder AppleShowAllFiles NO; killall Finder'
