#!/usr/bin/env bash
set -euo pipefail

# Print the tracked files that should be exported to the public OSS repository.
# Usage:
#   scripts/oss-export-manifest.sh > tmp/oss-export-manifest.txt
#   tar -cf tmp/publicar-oss-export.tar -T tmp/oss-export-manifest.txt
#
# The manifest is based on git ls-files so untracked local files are never
# exported. Private operational files are removed below. The public templates
# .dev.vars.example and wrangler.toml.example remain in the manifest.

git -c core.quotePath=false ls-files -z | while IFS= read -r -d '' path; do
  case "$path" in
    backlog/*) continue ;;
    .claude/*) continue ;;
    .agents/*) continue ;;
    .codex/*) continue ;;
    scripts/deploy-prd.sh) continue ;;
    docs/design/annotations/*) continue ;;
    docs/private/*) continue ;;
    wrangler.toml) continue ;;
    docs/development-workflow.md) continue ;;
    .dev.vars) continue ;;
    .dev.vars.*)
      [[ "$path" == ".dev.vars.example" ]] || continue
      ;;
  esac
  printf '%s\n' "$path"
done
