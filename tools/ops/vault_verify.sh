#!/bin/bash
# Verifies the Troya Index contracts on Blockscout through the Blockscout PRO API (the public explorer's API sits behind a
# Cloudflare challenge for scripts). The key is read from the server's .env and never printed.
# Usage: bash tools/ops/vault_verify.sh <swapper> <vault> <zap> <keeper>
set -e
cd "$(dirname "$0")/../../contracts"
export PATH="$HOME/.foundry/bin:$PATH"
K=$(ssh -i ~/.ssh/snipedesk_fra root@2.28.32.42 'grep ^BLOCKSCOUT_API_KEY= /srv/troya/.env | cut -d= -f2-')
node ../tools/ops/vault_verify_cmds.mjs "$@" | while read -r line; do
  addr=$(echo "$line" | awk '{for(i=1;i<=NF;i++) if ($i ~ /^0x[0-9a-fA-F]{40}$/) {print $i; exit}}')
  path=$(echo "$line" | awk '{for(i=1;i<=NF;i++) if ($i ~ /\.sol:/) {print $i; exit}}')
  args=$(echo "$line" | sed 's/.*--constructor-args //')
  echo "== $path $addr"
  forge verify-contract --chain 4663 --verifier blockscout --verifier-url "https://api.blockscout.com/4663/api?apikey=$K" "$addr" "$path" --constructor-args "$args" --watch 2>&1 | sed "s/$K/<key>/g" | grep -E "Pass|verified|Fail|Error|already" | tail -2
done
