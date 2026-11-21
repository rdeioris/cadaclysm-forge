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

- **A sequence that starts from a file starts from it converted.** The 0.14 files the corpus
  opens (`examples/`, `test/fixtures/forge-*.json`, and the inline `startText` of
  `a-broken-pick.json`, `box-fillet-resized.json`, `sheet-trim.json`, `three-bodies.json` and
  `website-demo.json` -- `a-notebook-opened.json` and `a-shown-node-opened.json` hold no forge
  node and are kept as they were) were converted once (`scripts/convert-examples.mjs`, gone
  since): each file's items read by the 0.14 layer on the 0.15 package and written, in item
  order, as the node layer writes them, the counters and the next id in the `forge` meta. A
  converted file is a fresh document: its nodes added in one commit, none of the 0.14
  history (no recorded step undoes past the file's own state). A 0.14 stand-in
  (`forge.broken_<type>`) is a `value.unresolved` in the 0.14 words. The 0.14 copies went
  with the 0.14 layer (`git log` has them).
- **A version-1 file's parts are not on nodes.** `forge-v1.json`'s join holds its parts
  inline, as a version-1 file had them (bodies of their own inside the item, no item of
  their own). The node layer has no such part (`"a version-1 part is not on nodes"`, spec
  decision 2), so the converted join is a stand-in: `forge-v1.json`'s "Join 1" fails from the
  open on, and so do what is made of it -- "Face 1" from step 27, "Fillet 1" from 39, "Press
  Pull 1" from 44 -- and the sketches and the curve on its faces (steps 29, 31, 33, 35) are
  refused ("#2 has not been built"). The surface beside it converts and builds as recorded.
  `golden.mjs`: `allow: "fails"`, `allow: "refused"`.
- **A pick on a body that has not built is a stand-in.** The 0.14 layer refused a command
  whose pick it could not resolve because the body it picks on does not build, unless the
  item was a stand-in already. The node layer writes the item as a stand-in in those words
  (5.3c: it builds again once a write finds the body; `test/forge-commands.mjs` pins it).
  `a-broken-pick.json` step 3 sets the edges of "Fillet 3", a fillet of the cut that leaves
  nothing: the 0.14 layer refused it (and its fillet of no edges built once the cut did, step
  4); here "Fillet 3" is a stand-in from step 3 on. The 0.14 layer on the 0.15 package
  refuses it too, so this is the port. `golden.mjs`: `{ step: 3, allow: "stands-in" }`,
  `{ from: 4, body: "Fillet 3", allow: "fails" }`.
- **A trim by a closed curve.** A trim is `curve.as_nurbs` -> `sheet.split_by_curve` (plan
  2.5) where the 0.14 layer cut by a `forge.curve_tool` sheet (`sheet.split_sheet`). By a
  circle, the cut edge is one closed edge with one vertex, where the 0.14 trim had two:
  "Trim 1" counts one vertex fewer (`sheet-trim.json`, `forge-sheet-trim.json`,
  `forge-kinds-made.json`), and so does a face item of it ("Face 1" in
  `forge-sheet-trim.json`, "Face 9" in `forge-kinds-made.json` steps 241-264). Area and
  bounds agree. The prism of it ("Solid 1" in `forge-kinds-made.json`) has one side face
  where it had two: 3 faces and 5 edges, not 4 and 4, and its volume 565.4863651654339
  where 0.14 measured 565.487020908092 -- the cylinder's exact 565.4866776 lies between
  them, each 5.8e-7 off, so the two differ by 1.2e-6 relative. A fillet of it with no edges
  (step 279, "Fillet 3") is the same solid, its cap face (step 267, "Face 9") another face
  index. Its face 3 is gone, so the commands that pick it (steps 273, 277, 283) are refused,
  and those that read the face item step 283 would have made (284, 286, 288, 290) too: the
  bodies they made are missing there (`lacks`). The 0.14 layer on the 0.15 package builds
  the trim as recorded, so this is the port. `golden.mjs`: `allow: "differs"` (named keys),
  `allow: "refused"`.

## The 0.15 kernel

Where the 0.15 kernel answers otherwise than the 0.14 one did. The 0.14 layer itself, run on
the 0.15 package over the same sequences, gives these very answers, so they are not the port.
`golden.mjs` lets the named summary keys differ (`allow: "kernel"`), or the body fail
(`allow: "fails"`), from the step given on.

- **A box's rounded edges.** Rounding two or four edges of a box meets in fewer edges than
  0.14 counted (the 0.15.0 package's fillet edge pins moved 24 -> 20 with it): `edges` in
  `a-fillet-s-life.json` step 3, `a-replica.json` from step 3, `busy.json` from step 5 and
  `held-bodies.json` from step 8 ("Fillet 1"); in the converted files, `a-broken-pick.json`
  ("Fillet 2", and "Fillet 1" from step 6, 17 not 18), `box-fillet-resized.json`,
  `forge-box-fillet.json` and `forge-kinds-made.json` (each box's fillet, refillet and the
  fillets the sequence makes of them). Faces, area and volume agree.
- **A press of a cone's curved face** counts 28 vertices, not 10 (`forge-kinds-quick.json`
  step 96, "Press Pull 1", `vertices`).
- **A box less a sphere counts 34 vertices**, not 16: `every-command.json` "Cut 1" from step
  19 and "Cut 1 copy" from step 58 (`vertices`).
- **The shell of that cut.** Its shell with face 0 open counts 68 vertices, not 32
  (`every-command.json` step 20, "Shell 1", `vertices`); with the face the page's own
  reference finds open (step 21 on) the 0.15 kernel refuses it: "shell: too thick: a face is
  narrower than two walls" (`allow: "fails"`).
- **A join of a box moved off a cylinder's middle** counts 20 edges, not 19:
  `the-scene-s-commands.json` step 20, "Join 1" (`edges`).

## Kernel follow-ups

- **A trim's split direction.** On a kernel whose `sheet.split_by_curve` takes `along`
  (0.15.1 on), a trim's split names its curve's own frame (`along`: the origin plane's key,
  the sketch, the face plane's frame node) and the kernel reads that frame's normal when the
  split evaluates: nothing is copied, and even a raw op on the sketch's frame turns the cut.
  On 0.15.0 the direction is still three numbers, the normal of the trim curve's frame as the
  document would evaluate it after the command's own ops so far, and forge-commands.js writes
  the trim again whenever a command writes anything it reads ("copies follow their source");
  a raw op on the frame, not through a forge command, leaves those numbers stale.
  No recorded step tilts a sketch under a trim.
