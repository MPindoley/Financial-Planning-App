# Matthew Pindoley, SE-AWMA® — Financial Planning Workspace

A self-contained financial-planning application for a fiduciary wealth-management
practice — modeled on the workflow of industry standards like eMoney, without a
client portal. Everything runs locally, works **offline** (perfect for client
meetings), saves to your computer, and prints beautiful client-ready reports.

> **Wealth, Engineered for Generations.**

---

## What it does

Eight modules, mapped to the way you actually run a planning conversation:

| Module | Purpose |
| --- | --- |
| **Dashboard** | One-screen snapshot — net worth, retirement funding, savings rate, protection gap, projection, goals, and top insights. |
| **Client Profile** | Capture the household's full picture — people, income, expenses, savings, accounts, debts, insurance, and assumptions. Everything else is driven from here. |
| **Needs Analysis** | Fast, single-goal estimates (retirement, education, protection) to **engage prospects quickly** and create immediate impact. |
| **Goals & Cash Flow** | Combine goals-based funding with comprehensive, year-by-year cash-flow planning. |
| **Foundational Planning** | The holistic full picture — net worth, allocation, retirement outlook, and goal funding in one confident view. |
| **Decision Center** | Model what-ifs live with sliders (retirement age, savings, return, spending, Social Security) and compare against the current plan in real time. |
| **CoPlanner** | Automated insights and a plan-readiness score that turn client data into ready-to-use planning actions. |
| **Report Center** | Generate a branded, multi-page client report and print it or save it as a PDF. |

### Built for the meeting room

- **Presentation Mode** (top bar → **Present**, or press **F**) — a clean,
  large-type, client-facing view that opens with a dark gold cover slide and
  hides all of your working inputs and controls.
- **"Hide from client"** toggles on each section — cover up anything you don't
  want the client to see, in both presentation and the printed report.
- **Privacy** (top bar → **Privacy**, or press **P**) — instantly blurs **every
  dollar figure** on screen. Useful when screen-sharing or if another client is
  nearby. (Printed reports are never blurred.)
- **Safe Screen** (top bar → **Safe**, or press **Esc**) — one click drops a
  branded cover over the entire screen if someone walks up.
- **Advisor Notes** — a private notes field that is **never** shown to the
  client and only appears in the optional "Advisor copy" of the report.

---

## Using it

### Open the app
Double-click **`index.html`** — it opens in any modern browser. No installation,
no internet, no accounts. For the smoothest experience (and to be sure web fonts
load), you can also serve it locally:

```bash
python3 -m http.server 8000      # then visit http://localhost:8000
```

> The app works fully offline; if there's no internet it simply falls back to
> elegant system fonts.

### Saving client plans
- Your work **auto-saves** to this browser on the same computer ("Saved"
  appears in the toolbar).
- Use the **plan switcher** (top-left, next to the logo) to keep **multiple
  client plans**, create a **New** plan, **Duplicate** one, or **Load sample**.
- **Export JSON** downloads a single backup file for a client — keep these in
  your client folders or move them between computers. **Import JSON** loads one
  back in. *Exporting is the reliable way to back up and transfer a plan.*

### Printing / saving a PDF for the meeting
1. Click **Report** in the toolbar.
2. Choose **Client copy** (excludes your private notes) or **Advisor copy**, and
   pick which sections to include.
3. Click **Print / Save as PDF**. In the browser's print dialog, choose your
   printer, or **"Save as PDF"** to keep a copy.

### Keyboard shortcuts
- **F** — enter / exit Presentation Mode
- **P** — toggle Privacy (blur amounts)
- **Esc** — Safe Screen (and closes dialogs / exits presentation)

---

## Files

| File | What it is |
| --- | --- |
| `index.html` | The app shell. Open this. |
| `styles.css` | All styling — screen, presentation, and print. |
| `app.js` | The planning engine, charts, and interface. |
| `.nojekyll` | Tells GitHub Pages to serve the files as-is. |

There is no build step and there are **no external dependencies** — the charts
are drawn as crisp inline SVG so they look perfect on screen and on paper.

---

## Optional: publish to GitHub Pages
If you'd like a private link instead of opening the file locally:

1. Commit `index.html`, `styles.css`, `app.js`, and `.nojekyll` to the repo root.
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**,
   pick your branch and the **`/ (root)`** folder, then **Save**.
4. After ~1 minute the workspace is live at
   `https://<your-username>.github.io/<repo-name>/`.

Because plans are saved per-browser, your client data stays on whichever device
you use — nothing is uploaded.

---

## A note on the numbers
All projections are **hypothetical illustrations** based on the data and
assumptions you enter (returns, inflation, taxes, Social Security, and life
expectancy). They are deterministic estimates for discussion purposes, not a
guarantee of future results, and not investment, tax, or legal advice. The
default assumptions are editable on the **Client Profile** screen, and every
printed report includes a disclosures page.
