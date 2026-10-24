# Where EPLAN drawings contradict themselves

Every item below was found in a real supplier drawing. Check each one and report it with both
sheet references.

## Identity and hardware

- [ ] **CPU or module type differs between sheets.** Compare the rack graphic, the power sheet
      and the parts list. The parts-list order number settles it (for example Siemens 1214C:
      `-1AG40` DC/DC/DC, `-1HG40` DC/DC/RLY, `-1BG40` AC/DC/RLY); the supply voltage only rules
      variants out.
- [ ] **Placeholder text left in.** Strings such as `*******####****` where device names, IP
      hosts or part descriptions should be. List each one.
- [ ] **Motor data that does not fit.** For example a rated power far above what the stated
      frame size carries (a 4-pole 132M frame is usually around 7.5 kW). Ask for the nameplate.
- [ ] **Supply sizing.** Add up the running currents that can coincide and compare with the main
      switch, the MCCB and the stated installed power. Ask whether units are interlocked.

## Tags and cross-references

- [ ] **One tag, two functions.** The same equipment number on two pumps (overview sheet against
      the motor sheet), or a cable number used under two function prefixes (`=F1-10W1` and
      `=F2+P1-10W1`).
- [ ] **Cross-references to boxes or pages that do not exist** (for example a reference to box
      "B2x1" where only "B2x0" exists).
- [ ] **Overview tables that disagree with the wiring on the same sheet.** For example an input
      row naming another module's terminal. `check_io_map.py` finds these.
- [ ] **Level or pressure switch tags and functions that differ** between the overview sheet and
      the I/O sheet (high against low, LS against LSH, different numbers).

## Function texts

- [ ] **PLC output texts swapped.** Follow each output to the coil it drives, and the coil to
      what it switches. Texts copied between rows survive into HMI tags.
- [ ] **Side or position names that contradict the wiring.** For example boxes titled "left"
      that carry the equipment every other "right" box carries. Trust the wiring, and confirm it
      with geometry when a site plan exists.
- [ ] **Contacts used twice.** The same contact numbers drawn in the safety loop and to a PLC
      input. Count the contact blocks in the parts list.

## Lists and lengths

- [ ] **Cable lengths that are not geometry.** For example a 45 m cable between two boxes a few
      metres apart. Treat lengths as allowances and use them only as an upper bound for a drawn
      route.
- [ ] **Missing classes of cable.** Ethernet, Modbus, and the incoming supply are often absent
      from the cable list. Say so, and ask.
- [ ] **Parts with no description** in the parts list (the placeholder text, or empty).

## Machine translation

- [ ] **Headers machine-translated from Spanish or German** ("lavado" rendered as "LOVED",
      "rearme cuadro" as "Remarme Blackboard"). Translate them in the reference with
      `glossary-es.md`, and never copy them into a message to site.
