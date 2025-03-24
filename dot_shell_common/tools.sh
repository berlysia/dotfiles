#!/bin/sh
# Common tool integrations for all shells

# mise integration
if [ -f "$HOME/.local/bin/mise" ]; then
  # The actual activation will be done in shell-specific files
  export HAS_MISE=1
fi

# opam configuration
if type opam &>/dev/null; then
  # The actual evaluation will be done in shell-specific files
  export HAS_OPAM=1
fi

# gcloud configuration with mise python
if type mise &>/dev/null && mise list | grep python >/dev/null && type gcloud &>/dev/null; then
  export CLOUDSDK_PYTHON="$(mise which python)"
fi
