#!/bin/sh
# Spawns a grandchild, then hangs. Used to prove the whole process group is killed.
sh -c 'while true; do sleep 0.2; done' &
echo "child:$!"
while true; do sleep 0.2; done
