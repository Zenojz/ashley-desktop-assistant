#!/usr/bin/env bash
set -euo pipefail

jarvis_app_path=${1:?Usage: sign-macos.sh /path/to/Jarvis.app}
# Defaults to ad-hoc signing. Set JARVIS_CODESIGN_IDENTITY to a Developer ID
# certificate name when producing a distributable notarized build.
jarvis_signing_identity=${JARVIS_CODESIGN_IDENTITY:--}

# Electron contains independently mapped Mach-O libraries. Signing only the
# outer app or using codesign --deep leaves libffmpeg and the GPU libraries
# with a different Team ID; dyld then refuses to start the app. Sign leaf code
# first, nested bundles second, and the outer app last. Resource files are
# deliberately excluded because signing .pak/.bin assets corrupts Electron.
while IFS= read -r -d '' jarvis_code_file; do
  if file -b "$jarvis_code_file" | grep -q 'Mach-O'; then
    codesign --force --timestamp=none \
      --sign "$jarvis_signing_identity" "$jarvis_code_file"
  fi
done < <(find "$jarvis_app_path/Contents" -type f -print0)

while IFS= read -r -d '' jarvis_code_bundle; do
  codesign --force --timestamp=none \
    --sign "$jarvis_signing_identity" "$jarvis_code_bundle"
done < <(find "$jarvis_app_path/Contents" -depth -type d \
  \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' \) -print0)

codesign --force --timestamp=none \
  --sign "$jarvis_signing_identity" "$jarvis_app_path"
codesign --verify --deep --strict --verbose=2 "$jarvis_app_path"
