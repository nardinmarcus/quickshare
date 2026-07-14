#!/usr/bin/env bash
set -euo pipefail

export NODE_ENV=production
export AUTH_ENABLED="${AUTH_ENABLED:-true}"

exec node --max-old-space-size=1024 server.js
