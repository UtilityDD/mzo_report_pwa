# PowerMap — Super Admin User Guide

Day-to-day reference. Editors and viewers do not see system tools or this guide.

---

## 1. Unlock & lock

1. Open **Settings**.
2. Leave **Name** empty.
3. Enter your **super admin PIN**.
4. Click **Unlock to edit** — top bar shows **Super admin**.
5. Click **Lock** when finished.

Session stays unlocked until you lock or close the tab.

---

## 2. Authorize editors

Only super admin can grant edit rights.

1. Unlock as super admin.
2. Under **Authorize editors**: enter **Name** and a **PIN** (4+ characters).
3. Click **Authorize for selective edit**.
4. They unlock with **their name + PIN**.
5. **Revoke** removes access immediately.

Editors can edit substations and related lines. They cannot authorize others or publish the full network.

---

## 3. Add a substation (Add SS)

1. Unlock.
2. Choose tool **Add Substation** on the left rail.
3. Place the SS either way:
   - **Click the map** at the intended location (preview marker + coordinates), **or**
   - Type **lat / lng** in the side panel and apply.
4. Confirm to create the substation (defaults to proposed / 33 kV).
5. In **Properties**, set name, voltage, status, transformers, etc. → **Save / Update**.

Status bar hint: click map or enter coordinates while Add SS is active.

---

## 4. Connect substations (Connect)

Creates a **trunk line** between two substations.

1. Unlock.
2. Choose tool **Connect**.
3. Click the **source** substation (highlighted).
4. Click the **target** substation.
5. The new line opens in **Properties** — set name, voltage, status, conductor, etc. → **Save / Update**.

Status bar: *Click source substation* → *Click target substation*.  
Click the same SS twice is rejected; pick a different target.

---

## 5. Tapping method (Tap)

Creates a **tap node** on a line and a **lateral** to a substation or another line.

### Tap to a substation

1. Unlock.
2. Choose tool **Tap**.
3. Click **anywhere on a trunk line** where the tap should start (tap node is placed on the line).
4. Click the **destination substation**.
5. The tap lateral opens in **Properties** — edit name / voltage / status → save as needed.

### Tap line-to-line

1. Same steps 1–3 above.
2. Instead of a substation, click **another trunk line** at the second tap point.
3. A lateral links the two tap nodes.

Status bar: *Click anywhere on a line to start tap* → *Click a substation or another line*.  
Do not click the same line again for the second point.

---

## 6. Edit a substation + related lines

1. Unlock → click a **substation** on the map.
2. Edit SS fields (name, voltage, status, lat/lng, transformers, etc.).
3. Under **Related lines**, edit connected trunk lines.
4. Click **Save SS & related lines**.

Tips: hide proposed assets in **Filters** if needed; use **Delete** only when sure (linked lines/taps may go with the SS).

---

## 7. Edit a line alone

1. Click a **line** — dashed **selection box** and square handles appear.
2. Edit properties → **Save / Update**.

---

## 8. Other map tools

| Tool | Use |
|------|-----|
| **Select** | Inspect or edit SS / line / tap |
| **Move** | Drag a substation; lines & taps follow |
| **Delete** | Remove an asset (confirm if linked) |
| **Measure** | Path distance |
| **Layers** | Basemap, districts, dim / undim |
| **Filters** | Voltage, proposed, division, etc. |
| **Reports** | KPIs, CSV / GeoJSON export |
| **Settings** | Unlock, editors, system, guide |

Edit tools require unlock. See sections 3–5 for **Add SS**, **Connect**, and **Tap**.

---

## 9. System actions (super only)

| Action | Meaning |
|--------|---------|
| **Check connection** | Confirm live network is reachable |
| **Publish network** | Push this browser’s full network to the cloud |
| **Refresh from cloud** | Reload the map from the live network |

Top bar: **Online · N SS · M lines** when connected. Publish only when you intend to overwrite the cloud copy.

---

## 10. Layers & districts

- Basemap options: Carto / Google / OSM / none.
- Click a district to focus; **Shift+click** for multi-focus.
- **Dim all** / **Undim all** for planning views.

---

## 11. Quick checklist

1. Unlock with your PIN.  
2. Authorize editors as needed.  
3. **Add SS** → place → save properties.  
4. **Connect** source SS → target SS → save line.  
5. **Tap** on line → SS or other line → edit lateral.  
6. Selective edit: SS + related lines → Save.  
7. Publish only when ready.  
8. Lock when done.

---

*In-app: Settings → User guide (while unlocked as super admin).*
