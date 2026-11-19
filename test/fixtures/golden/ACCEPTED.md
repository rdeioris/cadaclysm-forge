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
