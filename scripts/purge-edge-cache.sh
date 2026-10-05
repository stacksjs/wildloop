#!/usr/bin/env bash
# Drop Cloudflare's cached copies of wildloop.org.
#
# Run after anything changes which release serves the site: a deploy, or a
# rollback. A page cached before the change names the other build's
# fingerprinted CSS and JS, which the release now serving does not have.
#
# The token comes from .env.production (DOTENV_PRIVATE_KEY_PRODUCTION must be
# in the environment to decrypt it) and is never printed.
set -euo pipefail

token=$(./buddy env:get CLOUDFLARE_API_TOKEN --file .env.production 2>/dev/null | tail -1)
[ -n "$token" ] || { echo "no CLOUDFLARE_API_TOKEN in .env.production" >&2; exit 1; }
[ -z "${GITHUB_ACTIONS:-}" ] || echo "::add-mask::$token"

zone=$(curl -fsS -H "Authorization: Bearer $token" 'https://api.cloudflare.com/client/v4/zones?name=wildloop.org' | jq -r '.result[0].id')
curl -fsS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
  "https://api.cloudflare.com/client/v4/zones/$zone/purge_cache" \
  -d '{"hosts":["wildloop.org","www.wildloop.org"]}' | jq -e '.success' > /dev/null
echo "Purged wildloop.org at the edge"
