#!/bin/sh
# Traps and swallows SIGTERM so only SIGKILL can reap it. Proves the escalation ladder
# (SIGTERM -> grace -> SIGKILL) actually completes instead of hanging forever.
trap '' TERM
echo "ready"
while true; do sleep 0.2; done
