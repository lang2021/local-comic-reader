#!/bin/sh
set -eu

PROJECT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$PROJECT_DIR"
exec /usr/bin/env python3 "$PROJECT_DIR/app.py" --launch
