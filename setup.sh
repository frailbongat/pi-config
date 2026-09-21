#!/usr/bin/env bash
# Finish setting up ~/.pi on a new machine.
#
#   git clone https://github.com/frailbongat/pi-config.git ~/.pi
#   ~/.pi/setup.sh
#
# The clone gives you the tracked config. This script rebuilds the parts
# .gitignore leaves out on purpose: the extension dependency links, the skill
# symlinks, and a reminder about the files that hold secrets.
#
# Safe to re-run. It only replaces links it made itself.
set -euo pipefail

PI_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$1"; }

# 1. Locate the installed pi package.
#    Extensions import @earendil-works/pi-coding-agent. The package is a global
#    npm install, so each extension needs a node_modules link pointing at it.
if PI_PKG="$(npm root -g 2>/dev/null)/@earendil-works/pi-coding-agent" && [ -d "$PI_PKG" ]; then
  :
elif [ -d "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent" ]; then
  PI_PKG="/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent"
else
  warn "Cannot find @earendil-works/pi-coding-agent. Install pi first, then re-run."
  exit 1
fi
info "pi package at $PI_PKG"

# 2. Link dependencies into every extension that has a tsconfig.json.
#    node_modules/ is gitignored, so a fresh clone has none and the extension
#    fails to load. A broken /ship is the usual symptom.
for tsconfig in "$PI_HOME"/agent/extensions/*/tsconfig.json; do
  [ -e "$tsconfig" ] || continue
  ext_dir="$(dirname "$tsconfig")"
  dep_dir="$ext_dir/node_modules/@earendil-works"
  mkdir -p "$dep_dir"
  ln -sfn "$PI_PKG" "$dep_dir/pi-coding-agent"
  ln -sfn "$PI_PKG/node_modules/@earendil-works/pi-ai" "$dep_dir/pi-ai"
  echo "    linked $(basename "$ext_dir")"
done

# 3. Skills. agent/skills/* is gitignored because almost every entry is a
#    symlink into another repo. Committing them would only produce dangling
#    links here. frailbongat/skills owns the ones I wrote and links them in.
if [ -d "$HOME/skills/.git" ]; then
  info "Skills repo already at ~/skills"
else
  info "Cloning frailbongat/skills into ~/skills"
  git clone https://github.com/frailbongat/skills.git "$HOME/skills"
fi
info "Linking skills"
"$HOME/skills/install.sh"

# 4. Secrets. Never committed, so a new machine has to supply them.
missing=()
[ -f "$PI_HOME/agent/auth.json" ]       || missing+=("agent/auth.json (provider API keys, run 'pi' and log in)")
[ -f "$PI_HOME/agent/cliproxyapi.json" ] || missing+=("agent/cliproxyapi.json (proxy API key)")

if [ ${#missing[@]} -gt 0 ]; then
  warn "Still missing, copy from your other machine or recreate:"
  for m in "${missing[@]}"; do echo "    $m"; done
fi

info "Done. Start pi and run '/ship refs' to confirm the extension loaded."
