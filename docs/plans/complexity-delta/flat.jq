def walk(p):
  (p + [.name + ":" + .kind]) as $q
  | {key: ($q | join(" / ")), cognitive, anon: (.name == "<anonymous>")},
    (.children[]? | walk($q));

[ .files[]
  | (.path | sub("^.*/(o|n)/"; "")) as $f
  | .functions[]
  | walk([])
  | .key = ($f + " :: " + .key)
]
| map(select(.anon | not))
| map({(.key): .cognitive})
| add // {}
