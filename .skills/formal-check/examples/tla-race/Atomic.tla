---- MODULE Atomic ----
\* The check and the increment are one step, so the cap cannot be passed.
EXTENDS CapBase
VARIABLE done

Init == count = 0 /\ done = {}

Take(p) == /\ p \notin done
           /\ done' = done \cup {p}
           /\ count' = IF count < Cap THEN count + 1 ELSE count

Next == \E p \in Procs : Take(p)
====
