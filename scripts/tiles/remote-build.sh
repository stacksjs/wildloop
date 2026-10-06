#!/usr/bin/env bash
# Runs ON the temporary build server that scripts/tiles/build-planet.ts rents.
#
# Builds the OpenMapTiles-schema planet with planetiler, checks it with ts-maps'
# own PMTiles reader and decoder, uploads it to R2 under a dated key, and only
# then publishes tiles.json pointing at it.
#
# Nothing waits on this machine. It reports to the bucket instead: every few
# minutes, and on success or failure, it writes _builds/<version>/status.json
# (state, the last log line, a timestamp). The hourly `check` job reads that
# through tiles.wildloop.org and deletes this machine once the state is final.
#
# Expects /root/tiles/tiles.env (written over SSH, never in user data) with:
#   R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
#   TILES_PUBLIC_URL VERSION [SMOKE]
set -euo pipefail

cd /root/tiles
set -a
# shellcheck disable=SC1091
source ./tiles.env
set +a

# A machine whose check job never comes powers itself off a day in. Powered
# off still bills until it is deleted, but it stops the CPU hours, and the next
# check deletes it.
shutdown -P +1440 >/dev/null 2>&1 || true

# Packages first: Bun's installer needs unzip, which the cloud image lacks, and
# apt is locked until cloud-init has finished its own first-boot run. Until Bun
# is in, this machine cannot report; the check job allows it an hour of
# silence for exactly this stretch.
cloud-init status --wait >/dev/null 2>&1 || true
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq unzip curl openjdk-21-jre-headless >/dev/null

if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
export PATH="$HOME/.bun/bin:$PATH"

report() {
  echo "$1" > STATUS
  bun report.ts "$1" || true
}

heartbeat=''
finish() {
  [ -n "$heartbeat" ] && kill "$heartbeat" 2>/dev/null || true
}
trap finish EXIT
trap 'report FAILED; echo "build failed at line $LINENO"' ERR

report RUNNING
( while sleep 300; do report RUNNING; done ) &
heartbeat=$!

# Prove the upload path before spending hours building something to upload:
# write, read back and delete a small object through R2's S3 endpoint with the
# credentials publish.ts will use. A bad key, a missing bucket or an endpoint
# this datacentre cannot reach fails here, in the first minutes.
echo "==> R2 preflight"
bun -e '
  const s3 = new Bun.S3Client({ endpoint: process.env.R2_ENDPOINT, region: "auto", accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET })
  const key = `_builds/${process.env.VERSION}/preflight`
  await s3.file(key).write("ok")
  if ((await s3.file(key).text()) !== "ok") throw new Error("R2 read-back mismatch")
  await s3.file(key).delete()
  console.log("R2 reachable, credentials and bucket good")
'

if [ -n "${SMOKE:-}" ]; then
  echo "==> smoke run: stopping after the preflight"
  report DONE
  exit 0
fi

PLANETILER_VERSION=0.10.2
if [ ! -f planetiler.jar ]; then
  echo "==> planetiler ${PLANETILER_VERSION}"
  curl -fsSL -o planetiler.jar "https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar"
fi

# Planetiler's planet recipes, by memory. With 128 GB the node map is a plain
# array, three quarters of RAM is heap and the rest is page cache for the
# mmap'd feature storage: two to three hours on 32 cores. With 32 GB the node
# map goes sparse and to disk as well, and half of RAM is heap: the same
# archive, several times slower. Either way the downloads (planet.osm.pbf and
# the ocean, Natural Earth and lake side sources) are chunked in parallel.
memory=$(awk '/MemTotal/ { print int($2 / 1024 / 1024) }' /proc/meminfo)
if [ "$memory" -ge 100 ]; then
  heap=$(( memory * 3 / 4 ))
  storage=(--nodemap-type=array --storage=mmap)
else
  heap=$(( memory / 2 ))
  storage=(--nodemap-type=sparsearray --nodemap-storage=mmap --storage=mmap)
fi
echo "==> planetiler planet build (${memory}g RAM, heap ${heap}g, ${storage[*]})"
java -Xmx"${heap}g" -jar planetiler.jar \
  --area=planet --bounds=world \
  --download --download-threads=10 --download-chunk-size-mb=1000 \
  --fetch-wikidata \
  "${storage[@]}" \
  --output=/root/tiles/planet.pmtiles --force

ls -la planet.pmtiles

echo "==> verify and publish"
mkdir -p publish
cp publish.ts publish/
cd publish
[ -f package.json ] || echo '{ "name": "tiles-publish", "private": true }' > package.json
bun add ts-maps@latest >/dev/null
bun publish.ts /root/tiles/planet.pmtiles
cd ..

report DONE
echo "==> done"
