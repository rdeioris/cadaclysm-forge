# Golden corpus

What the forge built with SDK 0.14, recorded before its document layer moves onto general kernel
features. The new layer lays its document nodes out differently, so it is compared geometrically:
every body item, by its name ("Extrude 1"), with its kind, face, edge and vertex counts, whether
it is closed, its area and volume, and its bounds. Counts must match exactly. Area, volume and
bounds must match to 1e-6 relative. A body that failed must fail again; its `error` is the 0.14
message.

- `sequences/*.json`: a command sequence and the bodies after each step. Each `steps[].do` is
  `"open"`, `{"command": ...}` (a forge command), `{"op": ...}` (a raw document op), `"undo"` or
  `"redo"`. A refused command keeps its refusal and has no bodies. An undo or redo with
  `"bodies": null` restores a state recorded earlier in the same sequence.
- `start`: `null` for a sequence that starts from a new document. Otherwise it is the file it was
  opened from (`examples/...`, `test/fixtures/...`), or `"inline"` with the text in
  `startText`. Those are 0.14 forge files, so they can only be replayed once converted.
- `documents/*.json`: each forge document at its tip: its items and its bodies.
- A body with a `mass` field could not be measured (the 0.14 kernel refused: faces turned
  inward); its counts and bounds still hold.
- `INDEX.json` lists every file, its steps and how long it took to record.
