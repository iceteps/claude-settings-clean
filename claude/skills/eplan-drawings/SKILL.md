---
name: eplan-drawings
description: Read, extract and audit an EPLAN electrical drawing set (PDF schematics with =function+location-device tags, PLC I/O overviews, device/cable/terminal reports) — page index, device list, cable list with gauges, PLC I/O map, safety chain, power tree, and a fault hunt for the drawing's own contradictions; then place panels, boxes and cables onto a 3D model. Use when someone shares an electrical drawing or "electrical PDF", asks which cables/gauges go to a panel, asks what a PLC input does, wants an I/O list, wants the drawing checked, or wants electrical data in a 3D model (with `cad-model-views`).
---

# eplan-drawings: from a supplier's drawing PDF to answers you can trust

The goal is to be fluent in a supplier's drawing within one session. That means fast
answers ("which cables leave the main panel, with gauges?"), honest gaps ("the drawing gives
no Ethernet cable spec"), and a list of the drawing's own errors before they reach site.

**Toolkit** (`SKILL_DIR=~/.claude/skills/eplan-drawings`):

| Script | Does |
|---|---|
| `scripts/extract_eplan.py PDF OUT [--device-pages A-B] [--cable-pages A-B]` | `pages/pNNN.txt` text of every page, `pages.csv` (PDF page to page name and title), `devices.csv`, `cables.csv`. Finds the report pages from the table of contents, and fails loudly when the TOC does not match the PDF |
| `scripts/check_io_map.py IO.csv OUT/pages A-B [OUT/devices.csv]` | Checks a hand-typed I/O map against the PLC overview sheets, both directions, with exact device names; drawing errors are acknowledged per row in `pdf_device` |

References: `reference/faults-checklist.md` (where drawings contradict themselves) and
`reference/glossary-es.md` (machine-translated Spanish EPLAN terms).

Requirements: `python3` and poppler (`pdftotext`, `pdfinfo`, `pdftoppm`). The 3D steps need
the `cad-model-views` skill, if installed.

## 1. Ingest (minutes, not hours)

```
python3 -I $SKILL_DIR/scripts/extract_eplan.py drawing.pdf <project>/analysis/electrical
pdfinfo drawing.pdf | grep -i javascript      # supplier PDFs can carry JS; poppler never runs it
```

- Read the cover (supply, installed power, control voltage, client, serial) and the wire colour
  sheet first. Then read every page as an image (`Read` with `pages`, at most 20 per call),
  because symbols, arrows and boxes carry meaning that text loses. Use `pages/pNNN.txt` to search
  and to quote exact strings.
- **Tag grammar (IEC 81346)**: `=function +location -device :terminal`.
  - **Read this drawing's own structure identifiers before interpreting any prefix.** They are
    the supplier's choices and differ between drawing sets; look for a structure-identifier
    overview, the table of contents, or the title-block "=" and "+" fields.
  - A typical layout, for orientation only (placeholders, yours will differ):
    - `=F1` overviews and cables, `=F2` circuits, `=F3` box layouts, `=F4` pneumatics,
      `=REPORT` generated lists;
    - `+P1` main panel, `+PLC` rack, `+Bxx` field boxes;
    - `-X1` power terminals, `-X10` signals, `-X20` PLC outputs, `-XS` safety.
  - The extractor reads tags that carry function and location (`=F+L-D`). A drawing without
    `=` prefixes needs its own parsing; the extractor then fails rather than guessing.
  - Device letter codes vary with the standard in use (IEC 81346-2 letters, older IEC 60750
    letters or national practice). Common ones: Q or QM breaker, KM contactor, KA relay,
    T transformer, power supply or soft starter, M motor, S switch, SH lit button, B sensor,
    Y solenoid, W cable. Confirm them against the parts list.
  - **Cross-references** such as `/104.6` mean page 104, column 6 **within the current page's
    structure** (the same `=func+loc`). Sheet numbers repeat across structures (`=X+B10/1`,
    `=X+PLC/1`), so look pages up in `pages.csv` by the FULL page name, `=func+loc/N`. Page
    names are not PDF page numbers.
- **A device tagged under a panel is not necessarily in it.** EPLAN often tags field devices
  (photocells, e-stops) under the main panel's location. Location comes from boxes, layouts and
  the site plan, not from the tag.

## 2. Build the working set

Write these next to the drawing, in the project's analysis folder:

1. `pages.csv`, `devices.csv`, `cables.csv`: extracted in step 1.
   - The page count must equal the PDF's. If the table of contents does not match the PDF,
     the script fails and writes only `pages.UNTRUSTED.csv`; map pages from their title blocks.
   - Every report page must yield rows, and every cable field must sit under a column (fields
     are assigned by column position, so empty columns cannot shift values). The script fails
     otherwise.
   - For each report page, check that the first and last tags parsed match the range in its
     TOC title (`DEVICE TAG LIST : =A-1 - =A-9`). Do this by hand; the script does not.
   - Spot-check five rows against the page images.
2. `io_map.csv`: **typed from the circuit (wiring) sheets** where each input and output is
   drawn. Columns: `module, address, dir, terminal, device, signal, field_location, unit, sheet,
   pdf_device, note`.
   - Then run `check_io_map.py` against the **PLC overview (card) sheets**. Those are a
     different place in the drawing, which is what makes the check meaningful. Find them in
     `pages.csv` under the PLC location: titles like "CPU", "I/O overview", "digital
     input/output". Pass their PDF page numbers, not sheet numbers. A range that misses a card
     fails on the reverse check. Fix the map until it passes.
   - **Edit CSV files only through a CSV library**, never as text: an unquoted comma splits a
     field and shifts every later column. The check rejects rows of the wrong width.
   - Where the drawing itself is wrong, keep the real device in `device`, put the drawing's text
     in `pdf_device`, and write the reason in `note`. Never silence the check.
3. A **reference document** for people:
   - open items FIRST;
   - then identity, how to read the tags, a page map, locations, power tree, motors, the safety
     chain, PLC and network, field devices, pneumatics, field cables, drawing faults and a
     glossary.

   Label every fact **stated** (printed), **derived** (computed) or **inferred** (judgement),
   and cite the page.

## 3. Analyse what matters on site

- **Power tree**: incomer, main switch and breaker, earth leakage, every branch with its rating.
  Add up the running currents that can coincide and compare them with the switch and breaker
  ratings. A sum above the main switch is a question for the electrician, not a verdict.
- **Safety chain**: which e-stops are in the loop, what the safety contactors cut (often the
  24 V to the PLC output commons, so one e-stop stops everything), how reset is supervised, and
  which outputs stay live (lamps, beacons).
- **I/O**: count used against reserve per module, and check every output's text against the
  device it actually drives (swapped texts are common and reach the HMI tags).
- **Cables in/out of a panel**: every cable whose from/to lists that panel's terminal strips.
  Give label, gauge as written (`4G16` = 4 cores including earth, 16 mm²), route, length, and say
  that lengths are allowances. Say plainly when a class of cable (Ethernet, Modbus, the
  incoming supply) is not in the cable list at all.

## 4. Hunt the drawing's own faults

Work through `reference/faults-checklist.md`. Report each fault with both pages, ranked by
site risk, at the top of the reference.

## 5. Into 3D (with `cad-model-views`, if installed)

- Register the site plan or layout sheet onto the model (`register_plan.py`) using structural
  features, and validate on posts or panels you did not fit.
- Assign equipment to areas and units from the registered plan, not from intuition. Trust
  wiring over sheet titles when they disagree.
- Missing equipment shows see-through. On cable routes derived along modelled trays, the
  assumed legs are see-through. Each cable's info shows its drawn length against the allowance.

## 6. Messages and handover

If the user wants a message for a chat or e-mail, write it ready to paste: short numbered lines,
notes at the end, no emojis. Use the chat's own formatting (for example `*bold*` in WhatsApp).
Copy it with the platform clipboard tool if one is available (`wl-copy`, `xclip`, `pbcopy`) and
say so.

## Done means

- `extract_eplan.py` exits 0, with the page count equal to the PDF's.
- Report-page tag ranges match their TOC titles, and a spot-check of rows against the images
  passed.
- `check_io_map.py` exits 0 with the device list given.
- The reference opens with the open items, and every number in it carries a page citation and
  its basis (stated, derived or inferred).
- The fault list was walked in full, and its items are ranked.
