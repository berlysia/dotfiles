---- MODULE Racy ----
\* The check reads a copy of the count and the increment uses the current one,
\* so two processes can both pass the check and push the count past the cap.
EXTENDS CapBase
VARIABLES pc, seen

Init == /\ count = 0
        /\ pc = [p \in Procs |-> "read"]
        /\ seen = [p \in Procs |-> 0]

Read(p) == /\ pc[p] = "read"
           /\ seen' = [seen EXCEPT ![p] = count]
           /\ pc' = [pc EXCEPT ![p] = "write"]
           /\ UNCHANGED count

Write(p) == /\ pc[p] = "write"
            /\ pc' = [pc EXCEPT ![p] = "done"]
            /\ UNCHANGED seen
            /\ count' = IF seen[p] < Cap THEN count + 1 ELSE count

Next == \E p \in Procs : Read(p) \/ Write(p)
====
