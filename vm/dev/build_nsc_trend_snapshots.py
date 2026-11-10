#!/usr/bin/env python3
"""Read SAP PNSC .xlsb files → raw row JSON for Node snapshot builder (DETAILS sheet)."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from pyxlsb import open_workbook

DATE_RE = re.compile(r"(\d{1,2})-(\d{1,2})-(\d{4})")


def sheet_rows(path: Path):
    with open_workbook(path) as wb:
        names = list(wb.sheets)
        prefer = None
        for n in names:
            if str(n).strip().upper() == "DETAILS":
                prefer = n
                break
        if prefer is None:
            for n in names:
                if "summary" not in str(n).lower():
                    prefer = n
                    break
        if prefer is None:
            raise RuntimeError(f"No data sheet in {path.name}: {names}")
        with wb.get_sheet(prefer) as sh:
            header = None
            out = []
            for i, row in enumerate(sh.rows()):
                vals = [c.v for c in row]
                if header is None:
                    if not any(v is not None and str(v).strip() for v in vals):
                        continue
                    header = [str(v or "").strip() for v in vals]
                    continue
                if not any(v is not None and str(v).strip() for v in vals):
                    continue
                rec = {}
                for j, key in enumerate(header):
                    if not key:
                        continue
                    v = vals[j] if j < len(vals) else None
                    if v is None:
                        rec[key] = ""
                    else:
                        rec[key] = v if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v).strip()
                out.append(rec)
            return prefer, out


def main(argv):
    files = [Path(a) for a in argv[1:]]
    if not files:
        print("usage: build_nsc_trend_snapshots.py <file.xlsb>...", file=sys.stderr)
        return 2
    pack = []
    for p in files:
        m = DATE_RE.search(p.name)
        if not m:
            print(f"skip (no date in name): {p.name}", file=sys.stderr)
            continue
        d, mo, y = m.group(1).zfill(2), m.group(2).zfill(2), m.group(3)
        report_date = f"{d}/{mo}/{y}"  # dd/mm/yyyy
        report_key = f"{y}-{mo}-{d}"
        print(f"reading {p.name} → {report_date} …", flush=True)
        sheet, rows = sheet_rows(p)
        print(f"  sheet={sheet} rows={len(rows)}", flush=True)
        pack.append({
            "reportDate": report_date,
            "reportDateKey": report_key,
            "originalName": p.name,
            "rows": rows,
        })
    out = Path(__file__).resolve().parents[2] / "data" / "nsc_snapshot_import_raw.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(pack), encoding="utf-8")
    print(f"wrote {out} ({len(pack)} files)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
