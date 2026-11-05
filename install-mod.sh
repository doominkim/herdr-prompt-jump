#!/bin/sh
# Installs the Prompt Jump mod into the Herdr app. The folder appears whole (built aside, then moved),
# because the app places a new mod folder it sees without mod.json into the layout on its own.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
dest="$mods/prompt-jump"
tmp="$(dirname "$mods")/.prompt-jump.new.$$" # outside mods/: the app never sees it half-made
rm -rf "$tmp"
mkdir -p "$tmp"
cp "$here/mods/prompt-jump/mod.json" "$here/mods/prompt-jump/package.json" \
  "$here/mods/prompt-jump/"*.js "$here/mods/prompt-jump/"*.mjs "$tmp/"
[ -d "$dest" ] && cp "$dest"/gpui-kit.d.ts "$dest"/jsconfig.json "$tmp/" 2>/dev/null || true
rm -rf "$dest.old"
[ -d "$dest" ] && mv "$dest" "$dest.old"
mv "$tmp" "$dest"
rm -rf "$dest.old"
herdr-app check "$dest"
