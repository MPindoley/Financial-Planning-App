# Matthew Pindoley · SE-AWMA® — Wealth Management

An award-style, single-page 3D experience for a fiduciary wealth-management
practice. Hyperreal molten-gold centerpiece (Three.js) on an obsidian stage,
buttery momentum scrolling (Lenis), kinetic serif typography, and refined
micro-interactions — inspired by Hashgraph, Air Center, Off Menu, and Oryzo.

## Stack
- **One self-contained file:** `index.html` (no build step)
- **Three.js** — persistent WebGL gold object with real PBR reflections
- **GSAP + ScrollTrigger** — kinetic text reveals, scroll choreography
- **Lenis** — smooth momentum scroll (native touch on mobile)

All libraries load from CDN, so the only file the browser needs is `index.html`.

## Deploy to GitHub Pages
1. Commit `index.html` (and `.nojekyll`) to the repository root.
2. On GitHub: **Settings → Pages**.
3. Under **Build and deployment → Source**, choose **Deploy from a branch**.
4. Pick the branch (e.g. `main`) and folder **`/ (root)`**, then **Save**.
5. Wait ~1 minute — your site is live at
   `https://<your-username>.github.io/<repo-name>/`.

> `.nojekyll` tells GitHub Pages to serve files as-is (skip Jekyll processing).

## Local preview
Open `index.html` directly in a browser, or serve it:
```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

## Notes
- Fully responsive; respects `prefers-reduced-motion`.
- Resource links (`resource-*.html`) and `disclosure.html` point to your
  existing inner pages — keep those files in the repo, or update the hrefs.
- Replace the headshot URL in the About section if you host your own image.
