---
name: verify
description: How to run and verify the Turbo Rush 3D browser game in this repo
---

# Verifying Turbo Rush 3D

Static browser game (no build step): `index.html` + `game.js` + vendored
`lib/three.min.js`. Surface is the browser — drive it with Playwright
against the pre-installed Chromium.

## Recipe that works

1. `node --check game.js` for a quick syntax gate.
2. Install `playwright-core` in the scratchpad dir (npm registry is
   reachable through the proxy; unpkg/CDNs are blocked).
3. Launch with:
   ```js
   chromium.launch({
     executablePath: '/opt/pw-browsers/chromium',
     args: ['--use-gl=angle', '--use-angle=swiftshader', '--no-sandbox'],
   })
   ```
   (SwiftShader gives software WebGL in headless.)
4. `page.goto('file:///.../index.html')` — file:// works, no server needed.
5. Collect `console`/`pageerror` events; any error is a finding.

## Flows worth driving

- Loading bar → `#menu` becomes visible (`#menu:not(.hidden)`).
- Click `#startBtn` → `#hud` visible, `#score` ticking, `#speed` ~92 km/h.
- Hold `ArrowUp` → speed rises (boost); `ArrowRight` → car moves right.
- `p` toggles `#paused`; `m` shows MUTED in `#toast`.
- Hands-off run crashes into traffic within ~15 s → `#gameover` loses
  `.hidden`, `#finalScore` filled; `Enter` restarts and `#best` updates.
- Screenshot gameplay and eyeball it: NPC traffic must be visible both
  ahead (same direction) and oncoming across the median.
