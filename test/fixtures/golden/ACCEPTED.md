# Accepted differences

Where the node layer deliberately answers otherwise than the 0.14 layer recorded here. The
replay (`test/golden.mjs`) may differ from a recording only as listed.

- **A sketch fillet that cannot be done is refused.** The 0.14 layer's `round` did nothing
  (no error, an empty commit) when its JS fillet gave up: two lines that do not meet, a radius
  that does not fit. The node layer asks the kernel (`profile_fillet_corner`,
  `profile_round`) and refuses the command in its words ("the radius does not fit"). The page
  checks a fillet before it sends one, so only a hand-made command meets this.
  Sequence: `two-lines-rounded.json`, the `round` of radius 30.
