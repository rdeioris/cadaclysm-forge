# Accepted differences

Where the node layer deliberately answers otherwise than the 0.14 layer recorded here. The
replay (`test/golden.mjs`) may differ from a recording only as listed.

- **A sketch fillet that cannot be done is refused.** The 0.14 layer's `round` did nothing
  (no error, an empty commit) when its JS fillet gave up: two lines that do not meet, a radius
  that does not fit. The node layer asks the kernel (`profile_fillet_corner`,
  `profile_round`) and refuses the command in its words ("the radius does not fit"). The page
  checks a fillet before it sends one, so only a hand-made command meets this.
  Sequence: `two-lines-rounded.json`, the `round` of radius 30.
  The radius-30 `round` there is step 6, after the radius-3 one cut the two lines back so
  they no longer meet: refused ("the two curves do not meet at an end"), as the 0.14 layer's
  empty commit was not. `golden.mjs`: `{ step: 6, allow: "refused" }`.
- **A new body's pivot is the centre of its curves' exact bounds** (`profile_bounds`), not
  the middle of their Béziers' control-point box (spec, "Smaller decisions"). The two agree
  for lines, rectangles, polygons and whole circles and ellipses (to an ulp: a circle's exact
  bounds give 40.00000000000001 where the box gave 40); an arc's Béziers bulge past it, so a
  body over an arc pivots elsewhere. The pivot moves nothing until the body is scaled, turned
  in its plane or turned in the world, and then only where it is. No recorded step reaches
  such a body, so `golden.mjs` lists no case; `test/forge-commands.mjs` pins the rule.
- **A revolution of a curve builds.** `revolved` from a curve gave the body the curve's
  transform, which a curve has none of (`{}`), and the 0.14 layer's `worldAxis` refused it:
  "no axis". The axis is now written in sketch coordinates as the item holds it, and the
  in-plane move is a `solid.transform` after the verb (plan 5.3), so there is nothing to
  refuse: the body builds (an empty transform reads as the identity). The old layer on the
  0.15 package still refuses it, so this is the port, not the kernel. Sequence:
  `every-command.json`, "Revolution 1" from step 7 on; `golden.mjs`:
  `{ from: 7, body: "Revolution 1", allow: "builds" }`.
- **A raw op on the 0.14 trim's nodes is refused.** `a-late-tool.json` step 6 is a raw batch
  written against the 0.14 layout: it adds a `forge.curve_tool`, sets `i4_split`'s `tool` to
  it and removes `i4_tool`. A trim is now `curve.as_nurbs` `i4_tool` -> `sheet.split_by_curve`
  `i4_split` (whose curve field is `curve`, not `tool`) -> `solid.drop_faces` (plan 2.5), so
  the kernel refuses the batch ("`curve` names no node `i4_tool`") and the document stays as
  it was; the 0.14 recording there is an unreadable document. `golden.mjs`:
  `{ step: 6, allow: "raw-refused" }`.
- **A held body placed is summarized where it is.** `held-bodies.json` step 9 places the held
  plate 10 up. The 0.14 recorder measured a held item's own node (`plate`, unmoved); the node
  layer's item is its head `i1`, the placed `solid.transform` (5.3b), so its bounds are 10
  higher. The join over it moved in the recording too, so the place itself is the same.
  `golden.mjs`: `{ from: 9, body: "plate part", allow: "placed" }`.
- **A version-1 file's items are not loaded.** The 0.14 layer's `state` command replaced
  every item with a version-1 forge file's items (`itemFromV1`) and set the counters. The
  page sends it for no file it opens any more (it opens blacksmith documents only, and refuses
  a forge file of before in words), and 0.15 keeps no compatibility with old forge files
  (spec, decision 2), so the node layer refuses it: "state: a version-1 forge file's items
  are not loaded; open a document", the document as it was. Sequence: `every-command.json`
  step 63 (the last), where the 0.14 layer loaded a line and a box it could not build ("a
  quick solid without dims": `itemFromV1` drops a box's dims). `golden.mjs`:
  `{ step: 63, allow: "unsupported" }` (refused, that step's recording not compared).

## The 0.15 kernel

Where the 0.15 kernel answers otherwise than the 0.14 one did. The 0.14 layer itself, run on
the 0.15 package over the same sequences, gives these very answers, so they are not the port.
`golden.mjs` lets the named summary keys differ (`allow: "kernel"`), or the body fail
(`allow: "fails"`), from the step given on.

- **A box's rounded edges.** Rounding two or four edges of a box meets in fewer edges than
  0.14 counted (the 0.15.0 package's fillet edge pins moved 24 -> 20 with it): `edges` in
  `a-fillet-s-life.json` step 3, `a-replica.json` from step 3, `busy.json` from step 5 and
  `held-bodies.json` from step 8 ("Fillet 1"). Faces, area and volume agree.
- **A box less a sphere counts 34 vertices**, not 16: `every-command.json` "Cut 1" from step
  19 and "Cut 1 copy" from step 58 (`vertices`).
- **The shell of that cut.** Its shell with face 0 open counts 68 vertices, not 32
  (`every-command.json` step 20, "Shell 1", `vertices`); with the face the page's own
  reference finds open (step 21 on) the 0.15 kernel refuses it: "shell: too thick: a face is
  narrower than two walls" (`allow: "fails"`).
- **A join of a box moved off a cylinder's middle** counts 20 edges, not 19:
  `the-scene-s-commands.json` step 20, "Join 1" (`edges`).

## Kernel follow-ups

- **A trim's split direction is a literal.** `sheet.split_by_curve`'s `direction` is the
  normal of the trim curve's frame (an origin plane's, else the sketch's or face plane's
  frame node as the document last evaluated it, written as three numbers when the trim is
  written). Nothing in the document carries a frame's normal to a vector field (a frame is no
  number list to an expression, and no kind reads a frame's axis), so a sketch tilted later
  leaves the direction stale until the trim is written again. The 0.14 `forge.curve_tool`
  read the frame when it evaluated. A kernel follow-up: `sheet.split_by_curve` defaulting
  `direction` to the curve's own frame normal (or a `frame.normal` kind). No recorded step
  tilts a sketch under a trim.
