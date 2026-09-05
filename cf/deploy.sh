#!/usr/bin/env bash
# Deploy the worker with a fresh build stamp. Every page polls /agents and reloads itself the
# moment the stamp changes, so a deploy reaches the phone without anyone pulling to refresh.
set -euo pipefail
cd "$(dirname "$0")"
ENVF="/c/Users/Lloyd Gibbs/Claude Projects/godmode-site/.env.automation"
export CLOUDFLARE_API_TOKEN=$(grep -E '^CF_API_TOKEN=' "$ENVF" | cut -d= -f2- | tr -d '\r"')
export CLOUDFLARE_ACCOUNT_ID=$(grep -E '^CF_ACCOUNT_ID=' "$ENVF" | cut -d= -f2- | tr -d '\r"')
printf '{ "build": "%s" }\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > build.json
npx --yes wrangler@latest deploy 2>&1 | grep -E "Deployed|Version ID|rror" || true
echo "build $(cat build.json)"
