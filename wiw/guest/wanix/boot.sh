#!/bin/sh
(
  set -eu -o pipefail
  ulimit -f 262144
  export LC_ALL=C TZ=UTC PATH=/usr/local/bin:/usr/bin:/bin
  mount -t tmpfs -o size=192m tmpfs /tmp
  cp /wiw/workspace /tmp/wiw-workspace
  mkdir -p /tmp/incpption/checkout/source
  tar -xzf /wiw/source.tar.gz --strip-components=1 -C /tmp/incpption/checkout/source
  # The compiler and linker also have these target files on the browser side.
  if [ -f /wiw/sdk.tgz ]; then
    tar -xzf /wiw/sdk.tgz -C /tmp
  fi
  sh /wiw/build.sh
  /tmp/wiw-workspace /tmp/incpption/checkout /tmp/wiw-workspace.json /wiw/workspace.tar.gz > /wiw/removed.json
) > /wiw/log 2>&1
printf '%s\n' "$?" > /wiw/exit
