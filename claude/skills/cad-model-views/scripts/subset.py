"""Write a subset of shells.obj.

usage: subset.py SRC.obj DST.obj (--keep IDS | --drop IDS)
IDS is a comma list of shell indices or a path to a file with one index per line.
"""
import sys


def parse_ids(arg):
    if "," in arg or arg.isdigit():
        return {int(x) for x in arg.split(",") if x}
    return {int(x) for x in open(arg).read().split()}


if len(sys.argv) != 5 or sys.argv[3] not in ("--keep", "--drop"):
    sys.exit(__doc__)
src, dst, mode, ids = sys.argv[1], sys.argv[2], sys.argv[3], parse_ids(sys.argv[4])
keep = mode == "--keep"

seen = 0      # vertices read from SRC so far
written = 0   # vertices written to DST so far
offset = 0    # SRC index of the current object's first vertex, minus written
active = False
with open(src) as fin, open(dst, "w") as fout:
    for line in fin:
        tag = line[:2]
        if tag == "o ":
            idx = int(line[3:])
            active = (idx in ids) == keep
            offset = seen - written
            if active:
                fout.write(line)
        elif tag == "v ":
            seen += 1
            if active:
                fout.write(line)
                written += 1
        elif tag == "f " and active:
            a, b, c = (int(x) - offset for x in line[2:].split())
            fout.write(f"f {a} {b} {c}\n")
