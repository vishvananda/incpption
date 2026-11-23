#!/bin/sh
set -eu -o pipefail
while ! mkdir /tmp/wiw-tool.lock 2>/dev/null; do sleep 0.02; done
request=/wiw/call-$$
trap 'rm -rf "$request"; rmdir /tmp/wiw-tool.lock' EXIT
mkdir "$request"
{
  printf '%s\0' "$(pwd -P)" "${0##*/}" "$@"
} > "$request/args"
printf '%s\n' "$request" > /wiw/request
while [ ! -s "$request/reply" ]; do
  if [ -f "$request/snapshot" ] && [ ! -f "$request/inputs.ready" ]; then
    result=0
    /tmp/wiw-workspace /tmp/incpption/checkout /tmp/wiw-workspace.json "$request/inputs.tar.gz" > "$request/removed.json" || result=$?
    printf '%s\n' "$result" > "$request/inputs.ready"
  fi
  sleep 0.02
done
cat "$request/stdout"
cat "$request/stderr" >&2
if [ -s "$request/outputs.tar" ]; then
  tar -xf "$request/outputs.tar" -C /tmp/incpption/checkout
fi
exit "$(cat "$request/reply")"
