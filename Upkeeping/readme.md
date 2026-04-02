# Substation Upkeeping Score Sheet

An offline-first, highly responsive web application engineered for conducting comprehensive electrical substation audits, capturing photo evidence, and seamlessly syncing data to Google Sheets.

---

## 👥 For Users (Inspectors)

### Core Workflow
1. **Selection:** Choose the Division, Substation, and set the Visit Date from the main screen.
2. **Evaluation:** Tap on categories (e.g., *Cleanliness*, *Safety*) to record scores. You must score every item before finalizing. Click "Done" on a section—if you missed something, it will auto-scroll directly to the blank item.
3. **Evidence:** Easily upload photos and type remarks against individual components. Tap any thumbnail to open the Lightbox view for close-up inspections.
4. **Secure PIN Sign-off:** You do not type your name. Clicking **Submit Report** prompts you for your PIN. If authorized, the system securely injects your official identity into the document as the "Inspecting Officer."

### 📡 Offline Capabilities
This entire app works completely offline. If you have no network coverage:
- Continue auditing and hit Submit as normal.
- The report securely saves to your device.
- A red **Pending Indicator** will appear on the menu. 
- Once you return to a data connection, the app will instantly and silently upload the queued audits in the background.

---

## 🛠 For Developers

### Tech Stack & Architecture
* **Frontend:** Vanilla HTML, CSS (`@media` optimized for A4 + mobile), and JavaScript (`ES6+`). No bundlers required.
* **Architecture:** Offline-First. `OfflineQueue` handles indexed `localStorage`, while the `SyncEngine` binds to network events automatically triggering uploads when online.
* **Backend:** Google Apps Script (`doPost`/`doGet`) acting as the API broker to Google Sheets.
* **Media:** Photos are shrunk client-side via `<canvas>` and uploaded directly to Cloudinary.

### Directory Structure Map
* `index.html`: The core inspection application logic, caching handlers, auth-verification logic, and form engine.
* `view_report.html`: The Historical Archive. Uses hybrid caching logic to instantly display local data while concurrently refreshing from Google Sheets in the background.
* `report.html`: Fixed A4-width printable template for generating PDFs instantly after a local inspection. 
* `report1.html`: Fixed A4-width PDF layout engine designed strictly for archiving historical web data.
* `analytics.html`: Graphing UI reflecting overall historical upkeeping metrics.

### Authentication & Access
The PIN architecture is uncoupled from hardcoded logic. `App.fetchPinsFromCsv()` executes at submission time, matching user input against an external CSV. An inspector is only authorized if `row.PIN === pin` and `row['ss-autho'] === 'Y'`.
