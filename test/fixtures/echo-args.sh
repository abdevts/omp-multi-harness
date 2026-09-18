#!/bin/sh
# Prints its argv and whatever arrived on stdin, so tests can assert exact invocation.
echo "ARGS:$*"
echo "CWD:$(pwd)"
printf 'STDIN:'
cat
echo
