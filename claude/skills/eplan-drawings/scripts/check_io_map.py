"""Cross-check a hand-typed PLC I/O map against the drawing's PLC overview sheets.

usage: python3 -I check_io_map.py IO_MAP.csv PAGES_DIR FIRST-LAST [DEVICES.csv]
  IO_MAP.csv  columns at least: address, device, signal; optional: pdf_device
  PAGES_DIR   the pages/ folder written by extract_eplan.py
  FIRST-LAST  PDF pages of the PLC overview ("input/output overview", one card per module)
  DEVICES.csv optional device list from extract_eplan.py: rows that acknowledge a drawing
              error must then name a device that exists in it

On EPLAN PLC overview sheets each channel prints on one line as
  <function text> <device> <x-ref> I0.0      (inputs: device before the address)
  Q0.0 <x-ref> <device> <function text>      (outputs: device after the address)
For every address the drawing lists, the FIRST token of the map row's device cell must be the
same device tag as the drawing's (compared without terminal and location: '+B100-211S1:12'
and '211S1:12 (start panel)' are both 211S1; '13S1' is not '3S1'). A row may say "Reserve"
only where the drawing shows "RESERVE" or the card's own bare terminal for that address
(e.g. '+A1-X10:I2.1' for I2.1). An input wired to a field box is not reserve, even if spare.
Each address may appear only once in the map.

Reads Siemens English mnemonics (I0.0 / Q0.0) with "+location/sheet.column" cross-references;
German E/A addresses or %I forms find no channels, which is reported as a failure.

When the map deliberately differs (it names the real device where the drawing has an error),
put the drawing's device text in the row's `pdf_device` column, and say why in a note column.
That acknowledges the difference and the check passes.

Also fails when an address is in the map but not on the drawing, or the reverse.
Exit 0 = consistent; 1 = mismatches (listed).
"""
import csv
from collections import Counter
import os
import re
import sys

IN_RE = re.compile(r"(\S+)\s+\+\S+/\d+\.\d+\s+(I\d+\.\d)\b")
OUT_RE = re.compile(r"\b(Q\d+\.\d)\s+\+\S+/\d+\.\d+\s+(\S+)")


def base(dev):
    """Device tag without terminal and location: '+B100-211S1:12' -> '211S1'."""
    return dev.split(":")[0].rsplit("-", 1)[-1]


def main():
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    io_csv, pages_dir, span = sys.argv[1], sys.argv[2], sys.argv[3]
    first, _, last = span.partition("-")
    drawn = {}
    for p in range(int(first), int(last or first) + 1):
        for line in open(os.path.join(pages_dir, f"p{p:03d}.txt"), encoding="utf-8"):
            for dev, addr in IN_RE.findall(line):
                drawn[addr] = dev
            for addr, dev in OUT_RE.findall(line):
                drawn[addr] = dev
    all_rows = list(csv.DictReader(open(io_csv, encoding="utf-8")))
    rows = {r["address"]: r for r in all_rows}
    known = None
    if len(sys.argv) > 4:  # device tags without function/location, e.g. 211S2, 3S1
        known = {t["tag"].rsplit("-", 1)[-1] for t in csv.DictReader(open(sys.argv[4], encoding="utf-8"))}
    problems = [f"{a}: appears {n} times in the map" for a, n in
                sorted(Counter(r["address"] for r in all_rows).items()) if n > 1]
    # A row wider or narrower than the header means a field was split or lost (an unquoted comma
    # from a text edit): its later columns would be read as the wrong fields.
    raw = list(csv.reader(open(io_csv, encoding="utf-8")))
    problems += [f"{r[1] if len(r) > 1 else r}: row has {len(r)} fields, the header has {len(raw[0])} "
                 f"(a split or lost field: unquoted comma?)" for r in raw[1:] if r and len(r) != len(raw[0])]
    for addr, dev in sorted(drawn.items()):
        r = rows.get(addr)
        if r is None:
            problems.append(f"{addr}: on the drawing ({dev}) but not in the map")
            continue
        if r["signal"].strip().lower() == "reserve":
            cell = r["device"].split()[0] if r["device"].split() else ""
            if (dev.upper() == "RESERVE" or dev.rstrip(".").endswith(":" + addr)) \
                    and (not cell or base(cell.rstrip(".")) == base(dev.rstrip("."))):
                continue
            if cell and base(cell.rstrip(".")) != base(dev.rstrip(".")):
                problems.append(f"{addr}: reserve row names '{r['device']}', the drawing shows {dev}")
                continue
            problems.append(f"{addr}: map says Reserve but the drawing wires {dev} here")
            continue
        if r.get("pdf_device"):
            # Acknowledged drawing error: the drawing must still say exactly that, and the map
            # must name a real device (the acknowledgement is not a blank cheque).
            if r["pdf_device"] != dev:
                problems.append(f"{addr}: pdf_device says {r['pdf_device']}, the drawing now says {dev}")
            elif not r["device"].strip():
                problems.append(f"{addr}: acknowledged drawing error but the map names no device")
            elif base(r["device"].split()[0]) == base(dev):
                problems.append(f"{addr}: pdf_device set but the map names the drawing's own device")
            elif known is not None and base(r["device"].split()[0]) not in known:
                problems.append(f"{addr}: acknowledged row names '{r['device']}', which is not in the device list")
            continue
        if not r["device"].split() or base(r["device"].split()[0]) != base(dev):
            problems.append(f"{addr}: drawing says {dev}, map says '{r['device']}' "
                            f"(fix the map, or set pdf_device={dev} with a note if the drawing is wrong)")
    if not drawn:
        problems.append("no channels found on these pages: wrong page range, or a layout this check does not read")
    for addr in sorted(set(rows) - set(drawn)):
        problems.append(f"{addr}: in the map but not on the overview sheets")
    print(f"{len(drawn)} channels on the drawing, {len(rows)} in the map, {len(problems)} problems")
    for p in problems:
        print("  " + p)
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
