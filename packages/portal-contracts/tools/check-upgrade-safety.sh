#!/usr/bin/env bash
# Checks the contracts that sit behind a proxy or the beacon with OpenZeppelin's
# upgrades-core validator.
#
#   tools/check-upgrade-safety.sh [<baseline package dir>]
#
# <baseline package dir> is a checkout of packages/portal-contracts at the last release,
# with its submodules. With it, each contract is also checked as an upgrade of the
# baseline's version: storage variables may only be appended, and the gap must shrink by
# what was added. Without it, only the unsafe-pattern checks run.
#
# Needs forge, and the validator installed from the lockfile in tools/:
#
#   (cd tools && npm ci --ignore-scripts)
#
# It builds into a temporary directory, so neither checkout's out/ or cache/ is touched.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
baseline=${1:-}
cli="$here/tools/node_modules/.bin/openzeppelin-upgrades-core"

if [ ! -x "$cli" ]; then
  echo "error: the validator is not installed. Run: (cd $here/tools && npm ci --ignore-scripts)" >&2
  exit 2
fi
if [ -n "$baseline" ] && [ ! -f "$baseline/foundry.toml" ]; then
  echo "error: $baseline is not a portal-contracts checkout (no foundry.toml)." >&2
  exit 2
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

echo "Building $here"
build_info "$here" head
if [ -n "$baseline" ]; then
  echo "Building the baseline $baseline"
  build_info "$baseline" baseline
fi

validate() { # <contract> [extra validator options...]
  local contract=$1
  shift
  local args=("$work/head" --contract "$contract" "$@")
  if [ -n "$baseline" ]; then
    args+=(--reference "baseline:$contract" --referenceBuildInfoDirs "$work/baseline" --requireReference)
  fi
  "$cli" validate "${args[@]}"
}

validate PortalRegistry
validate PortalPoolFactory
# OpenZeppelin 5.5's ReentrancyGuard has a constructor, which the validator rejects in an
# upgradeable contract. The library marks it @custom:stateless and keeps its flag in a
# namespaced slot that reads as "not entered" when a proxy has never set it. Only that one
# library file is excluded; a constructor anywhere else is still an error.
validate PortalPoolImplementation --exclude "lib/openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol"

if [ -n "$baseline" ]; then
  echo "All three contracts are safe upgrades of the baseline."
else
  echo "No baseline given: unsafe patterns checked, storage not compared with a release."
fi
