#!/usr/bin/env bash
# Checks the contracts of a Foundry package that sit behind a proxy or a beacon, with
# OpenZeppelin's upgrades-core validator.
#
#   tools/upgrade-safety/check.sh <package dir> [<baseline package dir>]
#
# <package dir> must contain an `upgrade-safety.conf` that lists the contracts to check, one
# per line, each optionally followed by extra options for the validator. Lines starting with
# `#` are comments.
#
# <baseline package dir> is another checkout of the same package: the last release, or the
# base of a pull request. With it, each contract is also checked as an upgrade of the
# baseline's version: storage variables may only be appended, and a gap must shrink by what
# was added. Without it, only the unsafe-pattern checks run.
#
# Needs forge, and the validator installed from the lockfile next to this script:
#
#   (cd tools/upgrade-safety && npm ci --ignore-scripts)
#
# It builds into a temporary directory, so neither checkout's build output or cache is
# touched. Exit code: 0 all contracts pass, 1 a contract fails, 2 the check could not run.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cli="$here/node_modules/.bin/openzeppelin-upgrades-core"

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <package dir> [<baseline package dir>]" >&2
  exit 2
fi
if [ ! -x "$cli" ]; then
  echo "error: the validator is not installed. Run: (cd $here && npm ci --ignore-scripts)" >&2
  exit 2
fi

package=$(cd "$1" && pwd)
conf="$package/upgrade-safety.conf"
if [ ! -f "$conf" ]; then
  echo "error: $conf not found." >&2
  exit 2
fi

baseline=""
if [ $# -eq 2 ]; then
  if [ ! -f "$2/foundry.toml" ]; then
    echo "error: $2 is not a Foundry package (no foundry.toml)." >&2
    exit 2
  fi
  baseline=$(cd "$2" && pwd)
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The validator reads solc's full input and output, with storage layouts and ASTs.
build_info() { # <package dir> <name>
  if ! (cd "$1" && forge build --force --skip test --skip script \
    --out "$work/out-$2" --cache-path "$work/cache-$2" \
    --build-info --build-info-path "$work/$2" \
    --extra-output storageLayout --ast >"$work/build-$2.log" 2>&1); then
    cat "$work/build-$2.log" >&2
    echo "error: forge build failed in $1" >&2
    exit 2
  fi
}

echo "Building $package"
build_info "$package" head
if [ -n "$baseline" ]; then
  echo "Building the baseline $baseline"
  build_info "$baseline" baseline
fi

checked=0
compared=0
# The list is read on its own file descriptor so that nothing the validator reads from
# standard input can swallow lines of it.
while read -r contract options <&3 || [ -n "${contract:-}" ]; do
  case "$contract" in '' | '#'*) continue ;; esac
  args=("$work/head" --contract "$contract")
  if [ -n "$baseline" ]; then
    # A contract the baseline does not have yet has nothing to be compared with.
    if [ -n "$(find "$work/out-baseline" -name "$contract.json" -print -quit)" ]; then
      args+=(--reference "baseline:$contract" --referenceBuildInfoDirs "$work/baseline" --requireReference)
      compared=$((compared + 1))
    else
      echo "warning: $contract is not in the baseline: unsafe patterns checked, storage not compared." >&2
    fi
  fi
  # shellcheck disable=SC2086 # the options are split on spaces on purpose
  "$cli" validate "${args[@]}" $options
  checked=$((checked + 1))
done 3<"$conf"

if [ "$checked" -eq 0 ]; then
  echo "error: $conf lists no contracts." >&2
  exit 2
fi
if [ -n "$baseline" ]; then
  echo "$checked contracts pass; $compared of them compared with the baseline and safe to upgrade from it."
else
  echo "No baseline given: unsafe patterns checked in $checked contracts, storage not compared."
fi
