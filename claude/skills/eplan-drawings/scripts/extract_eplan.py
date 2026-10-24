"""Extract searchable text and machine-readable tables from an EPLAN drawing PDF.

usage: python3 -I extract_eplan.py DRAWING.pdf OUT_DIR [--device-pages A-B] [--cable-pages A-B]

Writes into OUT_DIR:
  pages/pNNN.txt  layout text of every page, for grep (the fastest way to find anything)
  pages.csv       PDF page -> EPLAN page name (=F2+P1/104) and title, from the table of contents
  devices.csv     device tag list report: tag, function text, sheet, part number, designation
  cables.csv      cable overview report: cable, from, to, type, cores, cores used, mm2, length, function
Report pages are found by their table-of-contents titles ("DEVICE TAG LIST", "CABLE OVERVIEW",
and the German/Spanish equivalents); pass the page ranges when the titles differ.
Tags must carry function and location (=F+L-D); drawings without "=" prefixes are not read.

Self-check (exit 1 with FAIL lines): the TOC page count differs from the PDF (pages.csv is then
NOT written, only pages.UNTRUSTED.csv), no report pages found, a report page yields no rows,
a cable field does not sit under any column, or no fully filled cable row fixes the columns.
Needs poppler (pdftotext, pdfinfo). Reads the PDF only; embedded JavaScript is never run.
"""
import argparse
import csv
import os
import re
import subprocess
import sys

TOC_HEAD = re.compile(r"Table of contents|Inhaltsverzeichnis|Índice|Indice", re.I)
# A TOC row: page name, 2+ spaces, title, 2+ spaces, a date (d/m/y in any separator, or ISO).
TOC_ROW = re.compile(r"^\s*([=+]?\S*/[\w.]+)\s{2,}(.+?)\s{2,}"
                     r"(?:\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d\d-\d\d)", re.M)
DEVICE_TITLE = re.compile(r"DEVICE TAG LIST|BETRIEBSMITTELLISTE|LISTA DE (APARATOS|EQUIPOS)", re.I)
CABLE_TITLE = re.compile(r"CABLE OVERVIEW|KABEL[ÜU]BERSICHT|LISTA DE CABLES|RESUMEN DE CABLES", re.I)
TAG = re.compile(r"^(=\w+\+[^\s/]+?)\s+(.*?)\s*(=\w+\+\S+/[\d.]+)")  # a tag never contains "/"
CABLE_NAME = re.compile(r"^\s*(=\w+\S*-\d*W\d+)\s")
LOCATION = re.compile(r"=\w+\+\S+")
CABLE_TYPE = re.compile(r"(.+?\s(?:\d+\s)?)?(\d+G?)\s+(\d+)\s+([\d,.]+)\s+([\d,.]+)\s*(.*)")


def squeeze(s):
    return re.sub(r"\s+", " ", s).strip()


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True, encoding="utf-8").stdout


def page_size(pdf, page=None):
    """(width, height) of one page in points, and the page count."""
    info = run(["pdfinfo"] + (["-f", str(page), "-l", str(page)] if page else []) + [pdf])
    w, h = re.search(r"Page(?:\s+\d+)? size:\s+([\d.]+) x ([\d.]+)", info).groups()
    pages = int(re.search(r"Pages:\s+(\d+)", info).group(1))
    return float(w), float(h), pages


def text(pdf, page, x=0, y=0, w=None, h=None):
    cmd = ["pdftotext", "-f", str(page), "-l", str(page), "-layout"]
    if w:
        cmd += ["-x", str(int(x)), "-y", str(int(y)), "-W", str(int(w)), "-H", str(int(h))]
    return run(cmd + [pdf, "-"])


def span(arg):
    a, _, b = arg.partition("-")
    return list(range(int(a), int(b or a) + 1))


def device_rows(pdf, page):
    """Device tag list: two report columns per page. Each record is a tag line, then (indented
    further) wrapped function text, then the part number and the type/designation. Everything
    right of the record's x-ref column is symbol and connection labels, so it is cut off."""
    width, height, _ = page_size(pdf, page)
    margin, half = 0.05 * width, width / 2
    rows = []
    for x in (margin, half):
        raw = [l for l in text(pdf, page, x, 0.1 * height, half - margin, 0.8 * height).splitlines() if l.strip()]
        i = 0
        while i < len(raw):
            m = TAG.match(squeeze(raw[i]))
            if not m:
                i += 1
                continue
            tag, func, xref = m.groups()
            lead = len(raw[i]) - len(raw[i].lstrip())
            cut = raw[i].index(xref)
            fcol = raw[i].index(func.split()[0], lead + len(tag)) if func else cut  # function column
            plain, j = [], i + 1
            while j < len(raw) and not TAG.match(squeeze(raw[j])) and not squeeze(raw[j]).startswith("Device tag"):
                line = raw[j][:cut]
                if line.strip():
                    indent = len(line) - len(line.lstrip())
                    if indent >= fcol - 2 and not plain:  # under the function text: it wraps
                        func = squeeze(func + " " + line)
                    elif indent <= lead:
                        plain.append(squeeze(line))
                j += 1
            rows.append([tag, func, xref, plain[0] if plain else "", plain[1] if len(plain) > 1 else ""])
            i = j
    return rows


NUMERIC = ("cores", "used", "mm2", "length")


def cable_rows(page_text):
    """Cable overview. Every field is a COLUMN and any of them may be empty, so each token goes
    to the column it sits under, never by its order. Column positions come from the first row
    whose type, cores, used, cross-section and length are all filled (numbers are right-aligned:
    their END positions line up). Continuation lines add further terminal strips."""
    lines = page_text.splitlines()
    loc_cols = num_ends = None
    func_starts = []
    for line in lines:
        m = CABLE_NAME.match(line)
        if not m:
            continue
        toks = list(LOCATION.finditer(line, m.end()))
        if len(toks) < 2:
            continue
        loc_cols = loc_cols or (toks[0].start(), toks[1].start())
        off = toks[-1].end()
        t = CABLE_TYPE.match(line[off:].strip())
        if not (t and t.group(1)):
            continue
        words = list(re.finditer(r"\S+", line[off:]))
        k = next(i for i, w in enumerate(words) if w.group() == t.group(2) and i >= 1)
        if num_ends is None:  # the four numbers (cores, used, mm2, length) are right-aligned
            num_ends = [off + w.end() for w in words[k:k + 4]]
        # Function text starts where the first NON-numeric word after the four numbers starts.
        tail = [w for w in words[k + 4:] if not re.fullmatch(r"[\d,.]+", w.group())]
        if tail:
            func_starts.append(off + tail[0].start())
    func_col = min(func_starts) if func_starts else (num_ends[-1] + 6 if num_ends else None)
    if loc_cols is None or num_ends is None:
        return [], [], ["no fully filled cable row: column positions unknown"]

    def side(tokens):
        src, dst = [], []
        for tk in tokens:
            (src if abs(tk.start() - loc_cols[0]) <= abs(tk.start() - loc_cols[1]) else dst).append(tk.group())
        return src, dst

    rows, warnings, errors = [], [], []
    for line in lines:
        m = CABLE_NAME.match(line)
        if m:
            toks = [tk for tk in LOCATION.finditer(line, m.end()) if tk.start() < loc_cols[1] + 20]
            src, dst = side(toks)
            after = toks[-1].end() if toks else m.end()
            fields = {k: "" for k in NUMERIC}
            ctype, func = [], []
            for w in re.finditer(r"\S+", line[after:]):
                a, b, text = after + w.start(), after + w.end(), w.group()
                if a >= func_col or func:  # once in the function column, the rest is function text
                    func.append(text)
                elif b < num_ends[0] - 4:  # left of the cores column: cable type text
                    ctype.append(text)
                else:
                    col = min(range(4), key=lambda i: abs(b - num_ends[i]))
                    if abs(b - num_ends[col]) > 5 or fields[NUMERIC[col]]:
                        errors.append(f"{m.group(1)}: token {text!r} at column {b} fits no field")
                    else:
                        fields[NUMERIC[col]] = text
            func_text = " ".join(func)
            if re.match(r"\d", func_text):
                warnings.append(f"{m.group(1)}: function text starts with a digit, check the row: {func_text!r}")
            rows.append([m.group(1), " ".join(src), " ".join(dst), " ".join(ctype), fields["cores"],
                         fields["used"], fields["mm2"].replace(",", "."), fields["length"].replace(",", "."),
                         func_text])
        elif rows and re.fullmatch(r"\s*(=\w+\+\S+\s*)+", line):
            src, dst = side(LOCATION.finditer(line))
            rows[-1][1] = " ".join(filter(None, [rows[-1][1]] + src))
            rows[-1][2] = " ".join(filter(None, [rows[-1][2]] + dst))
    return rows, warnings, errors


def write_csv(path, header, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        wr = csv.writer(f)
        wr.writerow(header)
        wr.writerows(rows)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("out")
    ap.add_argument("--device-pages", type=span)
    ap.add_argument("--cable-pages", type=span)
    a = ap.parse_args()
    _, _, n_pages = page_size(a.pdf)
    os.makedirs(os.path.join(a.out, "pages"), exist_ok=True)

    toc, texts = [], {}
    for p in range(1, n_pages + 1):
        texts[p] = text(a.pdf, p)
        with open(os.path.join(a.out, "pages", f"p{p:03d}.txt"), "w", encoding="utf-8") as f:
            f.write(texts[p])
        if TOC_HEAD.search(texts[p]):
            toc += TOC_ROW.findall(texts[p])
    errors = []
    toc_rows = [[p, sheet, squeeze(title)] for p, (sheet, title) in enumerate(toc, start=1)]
    if len(toc) == n_pages:
        write_csv(os.path.join(a.out, "pages.csv"), ["pdf_page", "sheet", "title"], toc_rows)
    else:
        # A shifted index is worse than none: write it under a name nobody looks up by mistake.
        if os.path.exists(os.path.join(a.out, "pages.csv")):
            os.remove(os.path.join(a.out, "pages.csv"))
        write_csv(os.path.join(a.out, "pages.UNTRUSTED.csv"), ["toc_order", "sheet", "title"], toc_rows)
        msg = (f"table of contents lists {len(toc)} pages, the PDF has {n_pages}: no pages.csv written "
               "(pages.UNTRUSTED.csv is the raw TOC); map pages from their title blocks")
        if a.device_pages and a.cable_pages:
            print("WARNING: " + msg)
        else:
            errors.append(msg + "; pass --device-pages and --cable-pages")

    titles = {p: t for p, (_, t) in enumerate(toc, start=1)}
    dev_pages = a.device_pages or [p for p, t in titles.items() if DEVICE_TITLE.search(t)]
    cab_pages = a.cable_pages or [p for p, t in titles.items() if CABLE_TITLE.search(t)]
    if not dev_pages:
        errors.append("no device tag list pages found (pass --device-pages)")
    if not cab_pages:
        errors.append("no cable overview pages found (pass --cable-pages)")

    # Self-check: every report page must yield rows, every row must parse cleanly.
    devices = []
    for p in dev_pages:
        rows = device_rows(a.pdf, p)
        if not rows:
            errors.append(f"device page {p} parsed to 0 rows (wrong page, or tags without =function+location)")
        devices += rows
    cables, warnings = [], []
    for p in cab_pages:
        rows, warn, err = cable_rows(texts[p])
        if not rows:
            errors.append(f"cable page {p} parsed to 0 rows")
        cables += rows
        warnings += [f"page {p}: {w}" for w in warn]
        errors += [f"page {p}: {e}" for e in err]
    write_csv(os.path.join(a.out, "devices.csv"),
              ["tag", "function_text", "drawn_on_sheet", "part_number", "type_and_designation"], devices)
    write_csv(os.path.join(a.out, "cables.csv"),
              ["cable", "from", "to", "type", "cores", "cores_used", "mm2", "length_m", "function"], cables)

    print(f"pages {n_pages} (toc {len(toc)})  device pages {dev_pages}  devices {len(devices)}  "
          f"cable pages {cab_pages}  cables {len(cables)}")
    for w in warnings:
        print("WARNING: " + w)
    for e in errors:
        print("FAIL: " + e)
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
