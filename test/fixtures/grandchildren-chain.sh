#!/bin/sh
# Spawns child -> grandchild -> great-grandchild, each printing its own pid, then all hang.
# Proves process-group kill reaps the *entire* tree, not just the direct child.
sh -c '
	sh -c "
		while true; do sleep 0.2; done &
		echo greatgrandchild:\$!
		wait
	" &
	echo grandchild:$!
	wait
' &
echo child:$!
while true; do sleep 0.2; done
