#!/bin/sh
# Copy signer keystore (and eth password) from ./data into ./data-staging for a
# second DMZ stack. Does not copy livepeer/sqlite runtime files — livepeer recreates those.
set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SRC="${SIGNER_DATA_SRC:-$ROOT/data}"
DST="${SIGNER_DATA_DIR:-$ROOT/data-staging}"

if [ ! -d "$SRC/keystore" ]; then
  echo "init-staging-data: missing $SRC/keystore (start the primary signer once or create data/)" >&2
  exit 1
fi

mkdir -p "$DST/keystore"
cp -a "$SRC/keystore/." "$DST/keystore/"
if [ -f "$SRC/.eth-password" ]; then
  cp -a "$SRC/.eth-password" "$DST/.eth-password"
else
  echo "" >"$DST/.eth-password"
  echo "init-staging-data: created empty $DST/.eth-password"
fi

# livepeer in the image runs as uid/gid 10001 (pymthouse)
if command -v chown >/dev/null 2>&1; then
  chown -R 10001:10001 "$DST" 2>/dev/null || \
    echo "init-staging-data: warning: could not chown $DST to 10001:10001 (run: sudo chown -R 10001:10001 $DST)" >&2
fi

echo "init-staging-data: keystore copied to $DST/keystore ($(find "$DST/keystore" -type f | wc -l) file(s))"
