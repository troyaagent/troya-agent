#!/bin/bash
# deploy only the given repo-relative paths (files or folders) to /srv/troya, then restart troya if any server code changed.
# Used while other agents have unfinished edits in the working tree (deploy.sh would ship those too).
set -e
cd /Users/danang/Desktop/TROYAAGENT
K=~/.ssh/snipedesk_fra; H=root@2.28.32.42; restart=0
for p in "$@"; do
  [ -e "$p" ] || { echo "missing $p"; exit 1; }
  if [ -d "$p" ]; then rsync -az -e "ssh -i $K -o BatchMode=yes" "$p/" "$H:/srv/troya/$p/"; else rsync -az -e "ssh -i $K -o BatchMode=yes" "$p" "$H:/srv/troya/$p"; fi
  case "$p" in server*|server.mjs) restart=1;; esac
  echo "synced $p"
done
ssh -i $K -o BatchMode=yes $H "chown -R troya:troya /srv/troya/public /srv/troya/server 2>/dev/null; true"
if [ "$restart" = 1 ] || [ "$FORCE_RESTART" = 1 ]; then ssh -i $K -o BatchMode=yes $H "systemctl restart troya; sleep 2; systemctl is-active troya"; fi
# Cloudflare (since 27 Nov 2026): purge what was just deployed so visitors get it at once. A public file is purged by its
# URL; a folder, a server change or an HTML page purges the whole zone (the edge cache refills in seconds).
CFENV=~/.config/cloudflare/api.env; CFZONE=0015189f71c96cc85e706ddff84fdee7
if [ -f "$CFENV" ]; then
  set -a; . "$CFENV"; set +a
  urls=(); everything=0
  for p in "$@"; do
    case "$p" in
      public/*) if [ -d "$p" ]; then everything=1; else u="https://troya.codes/${p#public/}"; urls+=("\"$u\""); case "$p" in *.html) everything=1;; esac; fi;;
      server*|server.mjs) everything=1;;
    esac
  done
  if [ "$everything" = 1 ]; then body='{"purge_everything":true}'; elif [ ${#urls[@]} -gt 0 ]; then body="{\"files\":[$(IFS=,; echo "${urls[*]}")]}"; else body=""; fi
  if [ -n "$body" ]; then
    r=$(curl -s -m 20 -X POST "https://api.cloudflare.com/client/v4/zones/$CFZONE/purge_cache" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" --data "$body" | grep -o '"success":[a-z]*' | head -1)
    echo "cloudflare purge: $r"
  fi
fi
