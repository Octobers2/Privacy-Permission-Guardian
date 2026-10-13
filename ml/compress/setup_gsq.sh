#!/usr/bin/env bash
# Idempotently register the ToS calibration loader in the vendored GSQ checkout.
set -euo pipefail
F="$(dirname "$0")/../vendor/GSQ/src/data/dataset.py"
LINE="import sys; sys.path.insert(0, '$(cd "$(dirname "$0")" && pwd)'); from tos_dataset import tos  # ppg"
grep -q "# ppg" "$F" || printf '\n%s\n' "$LINE" >> "$F"
echo "registered tos dataset in $F"
