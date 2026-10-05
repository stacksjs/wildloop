#!/usr/bin/env bash
# Put back the release every site was serving before this deploy.
#
#     scripts/rollback-this-deploy.sh <commit-sha> [environment]
#
# Run by the deploy workflow when the deploy or its smoke check fails. Only a
# site whose live release IS this commit is rolled back: a site this run never
# switched (it failed earlier, or its own cutover already restored itself) is
# left alone, because rolling it back would take it to a release older than
# the one it is happily serving.
#
# Which release is live is asked of ts-cloud's dry run, which reads the box
# and changes nothing (@stacksjs/ts-cloud >= 0.16.33; older versions ignored
# --dry-run and really rolled back).
#
# Exits non-zero when any rollback that was needed failed.
set -uo pipefail

sha="${1:?commit sha}"
env="${2:-production}"
status=0

for site in main api ingest; do
  plan=$(./buddy deploy:rollback "$site" --env "$env" --dry-run 2>&1 | grep -oE 'would roll back from [^ ]+ to [^ ]+' | head -1)
  live=$(printf '%s' "$plan" | awk '{print $5}')
  target=$(printf '%s' "$plan" | awk '{print $7}')

  if [ -z "$live" ]; then
    echo "::warning::$site: could not tell which release is live; leaving it alone"
    continue
  fi
  case "$sha" in
    "$live"*) ;;
    *) echo "$site is serving $live, not this deploy; leaving it alone"; continue ;;
  esac

  echo "Rolling $site back from $live to $target"
  if ./buddy deploy:rollback "$site" --env "$env" 2>&1 | grep -E 'Rolled back|rolled back to|did not stay up|failed|error'; then :; fi
  now=$(./buddy deploy:rollback "$site" --env "$env" --dry-run 2>&1 | grep -oE 'would roll back from [^ ]+' | awk '{print $5}')
  if [ "$now" = "$target" ]; then
    echo "$site is serving $target again"
  else
    echo "::error::$site rollback did not take: it is serving ${now:-unknown}"
    status=1
  fi
done

exit $status
