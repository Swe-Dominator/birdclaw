#!/bin/sh
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
bun=$("$script_dir/install-bun-canary.sh")
PATH=$(dirname "$bun"):$PATH
export PATH
export DO_NOT_TRACK="${DO_NOT_TRACK:-1}"
exec "$bun" --no-env-file "$@"
