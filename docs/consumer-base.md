# Consumer & meter profile

Study page that puts **Live consumers** as the common reference, then shows Defective, Smart meter, and Unbilled as **rates** of that base. Sibling idea to the OSD hub ([osd-revenue.md](osd-revenue.md)): one denominator, many shares.

## Decisions (locked)

| Choice | Value |
|--------|--------|
| Denominator | **Live-only** (`CONN_STAT === 'LIVE'` on Consumers) |
| Numerators (wave 1) | Defective + Smart (installed) + Unbilled (current-month summary; outsort+chronic fallback) |
| Build | **Browser-join prototype** first (no new DB2 job) |
| Name / URL | **Consumer & meter profile** → `consumer/profile.html` |
| Nav | Consumers & meters → first item |

## Formula

```
live[ccc]      = Σ consumers.count where conn_stat = LIVE and ccc_code = ccc
defective[ccc] = Σ defective_summary.total by ccc_code
smart[ccc]     = count smart_meter_status rows with installed flag, by ccc_final
unbilled[ccc]  = Σ summary.UNBILLED_COUNT by CCC_CODE (same as Unbilled page “Current Month”); else outsort+chronic row counts

defective / smart → % of Live
unbilled → count per 1 lakh Live (`/ 1L`) — rare rates stay readable
```

Join key: **CCC code** only (via uniform `_ccc` / `ccc_code` / `MzoScope`), never office name alone. Login scope: `MzoScope` / `MzoRows` as usual.

## Sources (existing)

| Piece | Key / API | Notes |
|--------|-----------|--------|
| Live base | `MzoRows` `consumers` | Pre-aggregated sheet; filter `conn_stat === 'LIVE'` |
| Defective | `MzoRows` `defective_summary` | Sum `total` |
| Smart | `MzoRows` `smart_meter_status` | Installed = non-empty `meter_installed_qty_in_field_active_in_hes` |
| Unbilled | `GET /api/unbilled/summary` (+ outsort/chronic fallback) | Same CSV parse as unbilled.html (TSV/CSV); empty if CRM sync not on this host |

Each source’s as-of (when known) is shown; do not pretend one snapshot date.

## Page behaviour

- KPIs: Live consumers · Defective % · Smart % · Unbilled %
- Rate strip: three shares of Live (defective / smart / unbilled)
- Tabs: Office (default) · Rank by defective % · Rank by smart % · Rank by unbilled %
- Jump cards: Consumers · Defective meter · Smart meter · Unbilled
- Soft handling: missing unbilled → 0 + note “Unbilled not on this server”

## Later (not this prototype)

- Server-written `consumer_base_summary.json`
- Class-split rates (DOM Live vs DOM defective)
- Wave 2: Pending MC, docket per 1,000, OSD defaulters % of Live
- DB2 Live consumer master if the sheet base is weak

## Check

Signed in, light/dark, desktop and ~390px, inside `app.html` and alone. Counts under filters should match unfiltered zone totals when filters cleared. No production writes.
