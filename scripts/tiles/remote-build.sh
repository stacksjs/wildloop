#!/usr/bin/env bash
# Runs ON the temporary build server that scripts/tiles/build-planet.ts rents.
#
# Builds the OpenMapTiles-schema planet with planetiler, checks it with ts-maps'
# own PMTiles reader and decoder, uploads it to R2 under a dated key, and only
# then publishes tiles.json pointing at it. The orchestrator watches STATUS and
# the log over SSH, and deletes this machine whatever happens.
#
# Expects /root/tiles/tiles.env (written over SSH, never in user data) with:
#   R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
#   TILES_PUBLIC_URL VERSION
set -euo pipefail

cd /root/tiles
set -a
# shellcheck disable=SC1091
source ./tiles.env
set +a

status() { echo "$1" > STATUS; }
trap 'status FAILED; echo "build failed at line $LINENO"' ERR
status RUNNING

# A machine that outlives the orchestrator powers itself off, so a crashed CI
# run cannot leave a 32-core box billing by the hour. The orchestrator deletes
# it long before this fires.
shutdown -P +480 >/dev/null 2>&1 || true

echo "==> waiting for cloud-init"
cloud-init status --wait >/dev/null 2>&1 || true

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq openjdk-21-jre-headless curl unzip >/dev/null

if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
export PATH="$HOME/.bun/bin:$PATH"

# Prove the upload path before spending hours building something to upload:
# write and delete a small object through R2's S3 endpoint with the same
# credentials publish.ts will use. A bad key, a missing bucket or an endpoint
# this datacentre cannot reach fails here, in the first minutes.
echo "==> R2 preflight"
bun -e '
  const s3 = new Bun.S3Client({ endpoint: process.env.R2_ENDPOINT, region: "auto", accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET })
  const key = `preflight/${process.env.VERSION}-${Date.now()}`
  await s3.file(key).write("ok")
  if ((await s3.file(key).text()) !== "ok") throw new Error("R2 read-back mismatch")
  await s3.file(key).delete()
  console.log("R2 reachable, credentials and bucket good")
'

if [ -n "${SMOKE:-}" ]; then
  status DONE
  echo "==> smoke run: stopping after the preflight"
  exit 0
fi

PLANETILER_VERSION=0.10.2
if [ ! -f planetiler.jar ]; then
  echo "==> planetiler ${PLANETILER_VERSION}"
  curl -fsSL -o planetiler.jar "https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar"
fi

# Planetiler's documented planet recipe: the node map as an array on mmap'd
# storage keeps the heap at a fraction of RAM, and the downloads (planet.osm.pbf
# plus the ocean, Natural Earth and lake side sources) are chunked in parallel.
# Leaves a quarter of RAM to the page cache the mmap storage lives in.
heap=$(( $(awk '/MemTotal/ { print int($2 / 1024 / 1024) }' /proc/meminfo) * 3 / 4 ))
echo "==> planetiler planet build (heap ${heap}g)"
java -Xmx"${heap}g" -jar planetiler.jar \
  --area=planet --bounds=world \
  --download --download-threads=10 --download-chunk-size-mb=1000 \
  --fetch-wikidata \
  --nodemap-type=array --storage=mmap \
  --output=/root/tiles/planet.pmtiles --force

ls -la planet.pmtiles

echo "==> verify and publish"
mkdir -p publish
cp publish.ts publish/
cd publish
[ -f package.json ] || echo '{ "name": "tiles-publish", "private": true }' > package.json
bun add ts-maps@latest >/dev/null
bun publish.ts /root/tiles/planet.pmtiles

status DONE
echo "==> done"
