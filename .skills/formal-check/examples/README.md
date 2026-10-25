# formal-check examples

Each example is a manifest (`formal.json`) with a contract that must hold and a
broken variant that must be caught, linked by `brokenBy`. None of them has an
implementation behind it, so the contract's `covers` is empty and says why in
`note`.

| Example         | Kind      | What the contract checks                                                                                                        | How the broken variant breaks it                                                                           |
| --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `enumerate-cap` | enumerate | For every use count from 0 to 20, a cap of 10 never lets a use end above 10.                                                    | The boundary comparison is `<=` instead of `<`, so a count of exactly 10 is still allowed.                 |
| `z3-window`     | z3        | For every start and end with `start <= end`, a closed time window overlaps itself.                                              | The comparison is strict (`<` for `<=`), so a window whose start equals its end no longer overlaps itself. |
| `tla-race`      | tla       | Two processes taking from a cap of 1 never push the count past it (`NeverOverCap`). `Atomic` checks and increments in one step. | `Racy` checks a stale copy of the count and increments the current one, so both processes pass the check.  |

`tla-race` also puts the shared definitions in a sibling module (`CapBase.tla`)
that both models `EXTEND`. TLC reads it from the model's directory, and
`--inspect` lists it among `modules`, so it is part of the digest.

## Running them

Run the script that sits next to this directory against a manifest:

```sh
node scripts/run.mjs examples/enumerate-cap/formal.json
```

`z3-window` and `tla-race` need the runtime (z3-solver, and `tla2tools.jar`
plus a JDK); `FORMAL_CHECK_HOME` points the harness at another install.

A manifest has to live in a subdirectory of a repository, never at its root.
A deployed copy has no repository above it, so copy an example into a temporary
directory and put an empty `.git` directory in the parent of the copy:

```sh
tmp=$(mktemp -d)
mkdir "$tmp/.git"
cp -R examples/tla-race "$tmp/tla-race"
node scripts/run.mjs "$tmp/tla-race/formal.json"
```
