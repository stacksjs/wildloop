#!/usr/bin/env bash
# Runs ON the temporary build server that scripts/tiles/build-planet.ts rents.
#
# Builds the OpenMapTiles-schema planet with planetiler, checks it with ts-maps'
# own PMTiles reader and decoder, uploads it to R2 under a dated key, and only
# then publishes tiles.json pointing at it.
#
# Nothing waits on this machine. It reports to the bucket instead: a heartbeat,
# independent of this script, writes _builds/<version>/status.json every five
# minutes with the state, the log's tail and the machine's disk and memory.
# The hourly `check` job reads that through tiles.wildloop.org. The machine
# terminates itself once it has reported a final state (EC2 is told to treat
# a shutdown as termination), and the check terminates it if it never does.
#
# Expects /root/tiles/tiles.env (written over SSH, never in user data) with:
#   R2_ENDPOINT R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET
#   TILES_PUBLIC_URL VERSION [SMOKE] [OSM_URL]
set -euo pipefail

cd /root/tiles
set -a
# shellcheck disable=SC1091
source ./tiles.env
set +a
echo $$ > build.pid

# Whatever happens, this machine is gone within twelve hours: a shutdown from
# inside terminates it. The check job terminates it far sooner.
shutdown -P +720 >/dev/null 2>&1 || true

# Packages first: Bun's installer needs unzip, which the cloud image lacks, and
# apt is locked until cloud-init has finished its own first-boot run. Until Bun
# is in, this machine cannot report; the check job allows it an hour of
# silence for exactly this stretch.
echo "==> packages"
cloud-init status --wait >/dev/null 2>&1 || true
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq unzip curl mdadm openjdk-21-jre-headless >/dev/null
if ! command -v bun >/dev/null; then
  curl -fsSL https://bun.sh/install | bash >/dev/null
fi
export PATH="$HOME/.bun/bin:$PATH"
BUN="$(command -v bun)"

# The work goes on the instance's own NVMe drives: the planet download,
# planetiler's node map and feature storage, and the archive are several
# hundred gigabytes together, and the node map is read at random billions of
# times. Two drives are striped into one. A machine without instance storage
# works on its root disk.
mapfile -t drives < <(lsblk -dn -o NAME,MODEL | awk '/Instance Storage/ { print "/dev/" $1 }')
if [ "${#drives[@]}" -ge 2 ]; then
  mdadm --create /dev/md0 --level=0 --raid-devices="${#drives[@]}" "${drives[@]}" --force --run >/dev/null 2>&1
  device=/dev/md0
elif [ "${#drives[@]}" -eq 1 ]; then
  device="${drives[0]}"
else
  device=''
fi
if [ -n "$device" ]; then
  mkfs.ext4 -q -F -E nodiscard "$device"
  mkdir -p /mnt/work
  mount -o noatime "$device" /mnt/work
  WORKDIR=/mnt/work/tiles
else
  WORKDIR=/root/tiles/work
fi
echo "==> working in $WORKDIR ($(df -h "$(dirname "$WORKDIR")" | awk 'NR==2 { print $2 }'))"
mkdir -p "$WORKDIR/tmp"
export WORKDIR

# The heartbeat outlives anything this script does, including dying: it runs
# detached, never with `set -e`, and writes only to the bucket. `auto` reports
# FAILED on its own when this script's process is gone without saying so.
setsid nohup bash -c "while true; do '$BUN' /root/tiles/report.ts auto >/dev/null 2>&1; sleep 300; done" >/dev/null 2>&1 < /dev/null &

finish() {
  echo "$1" > STATUS 2>/dev/null || true
  "$BUN" report.ts "$1" || true
  # Reported; nothing left for this machine to do. Terminates it.
  shutdown -h +1 >/dev/null 2>&1 || true
}
trap 'echo "build failed at line $LINENO"; finish FAILED' ERR
"$BUN" report.ts RUNNING || true

# Prove the upload path before spending hours building something to upload:
# write, read back and delete a small object through R2's S3 endpoint with the
# credentials publish.ts will use. A bad key, a missing bucket or an endpoint
# this datacentre cannot reach fails here, in the first minutes.
echo "==> R2 preflight"
"$BUN" -e '
  const s3 = new Bun.S3Client({ endpoint: process.env.R2_ENDPOINT, region: "auto", accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY, bucket: process.env.R2_BUCKET })
  const key = `_builds/${process.env.VERSION}/preflight`
  await s3.file(key).write("ok")
  if ((await s3.file(key).text()) !== "ok") throw new Error("R2 read-back mismatch")
  await s3.file(key).delete()
  console.log("R2 reachable, credentials and bucket good")
'

if [ -n "${SMOKE:-}" ]; then
  echo "==> smoke run: stopping after the preflight"
  finish DONE
  exit 0
fi

PLANETILER_VERSION=0.10.2
if [ ! -f "$WORKDIR/planetiler.jar" ]; then
  echo "==> planetiler ${PLANETILER_VERSION}"
  curl -fsSL -o "$WORKDIR/planetiler.jar" "https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar"
fi

# Planetiler's planet recipes, by memory. With 128 GB the node map is a plain
# array, three quarters of RAM is heap and the rest is page cache for the
# mmap'd feature storage: two to three hours on 32 cores. With 32 GB the node
# map goes sparse and to disk as well, and half of RAM is heap: the same
# archive, several times slower. Either way the downloads (planet.osm.pbf and
# the ocean, Natural Earth and lake side sources) are chunked in parallel.
#
# No --fetch-wikidata: it asks Wikidata's public query service for every
# place's name in other languages, which is rate-limited and takes over an
# hour on any machine, and the map's labels only ever use OpenStreetMap's own
# `name`.
memory=$(awk '/MemTotal/ { print int($2 / 1024 / 1024) }' /proc/meminfo)
if [ "$memory" -ge 200 ]; then
  # The node map (~100 GB) lives in the page cache, not the heap.
  heap=110
  storage=(--nodemap-type=array --storage=mmap)
elif [ "$memory" -ge 100 ]; then
  heap=$(( memory * 3 / 4 ))
  storage=(--nodemap-type=array --storage=mmap)
else
  heap=$(( memory / 2 ))
  storage=(--nodemap-type=sparsearray --nodemap-storage=mmap --storage=mmap)
fi
osm=()
[ -n "${OSM_URL:-}" ] && osm=(--osm_url="$OSM_URL")
echo "==> planetiler planet build (${memory}g RAM, heap ${heap}g, ${storage[*]}, work in ${WORKDIR})"
cd "$WORKDIR"
java -Xmx"${heap}g" -Djava.io.tmpdir="$WORKDIR/tmp" -jar planetiler.jar \
  --area=planet --bounds=world \
  --download --download-threads=16 --download-chunk-size-mb=1000 \
  "${osm[@]}" \
  "${storage[@]}" \
  --tmpdir="$WORKDIR/tmp" \
  --output="$WORKDIR/planet.pmtiles" --force

ls -la "$WORKDIR/planet.pmtiles"

echo "==> verify and publish"
mkdir -p /root/tiles/publish
cp /root/tiles/publish.ts /root/tiles/publish/
cd /root/tiles/publish
[ -f package.json ] || echo '{ "name": "tiles-publish", "private": true }' > package.json
"$BUN" add ts-maps@latest >/dev/null
"$BUN" publish.ts "$WORKDIR/planet.pmtiles"
cd /root/tiles

finish DONE
echo "==> done"
