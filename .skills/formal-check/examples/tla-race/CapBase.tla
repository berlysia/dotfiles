---- MODULE CapBase ----
\* Shared by Atomic and Racy: the processes, the cap, and the property.
EXTENDS Naturals
CONSTANT Cap
VARIABLE count

Procs == {1, 2}

NeverOverCap == count <= Cap
====
