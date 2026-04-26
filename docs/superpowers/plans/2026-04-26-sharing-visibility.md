# Sharing Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local user's mic / share-video / camera state unmistakable — by giving toolbar buttons a clear "off" appearance and by showing a "PARTNER CAN'T SEE YOU" ribbon over the local video preview when a partner is in the room and share-video is off.

**Architecture:** Pure HUD-layer change. Three files touched: `src/hud/components/VideoPanel.ts` (new SVG constants, `iconOn`/`iconOff` swap in `makeToolbarButton`, new `buildShareWarnOverlay` + `setPartnerPresent` + `recomputeShareWarn`), `src/hud/Hud.ts` (one-line forward in `setPartner`), and `src/hud/style.css` (off-state restyle for `.video-panel-toolbar-btn`, new `.video-panel-share-warn` rules). Reuses the existing `--danger` CSS variable; reuses the existing `partnerPresent` flag already maintained by `Hud.setPartner`. No changes to `Game.ts`, `webrtc.ts`, or `main.ts`.

**Tech Stack:** Vanilla TypeScript, Vite, plain DOM/CSS. No test framework — verification is `npm run build` for type+build correctness, and manual browser confirmation for visuals.

**Spec:** `docs/superpowers/specs/2026-04-26-sharing-visibility-design.md`

---

## File map

- **Modify** `src/hud/components/VideoPanel.ts` — add 3 `*_OFF_SVG` constants, change `makeToolbarButton` to take `iconOn`/`iconOff`, swap icons in the three `set*Enabled` setters, add `buildShareWarnOverlay`, `setPartnerPresent`, `recomputeShareWarn`.
- **Modify** `src/hud/Hud.ts` — one line at the end of `setPartner` to forward presence to the local panel.
- **Modify** `src/hud/style.css` — drop the warm inner-glow from off-state buttons, lift opacity to 1.0, restyle the slash icon via `currentColor`, add `.video-panel-share-warn` rules.

## Verification cadence

After each task:
- Run `npm run build` and confirm it passes (this runs `tsc --noEmit && vite build`).
- For tasks that change visual output, the engineer should `npm run dev`, open the app, and visually confirm the described behavior.

---

### Task 1: Add slashed-icon SVG constants

**Files:**
- Modify: `src/hud/components/VideoPanel.ts:21-45`

- [ ] **Step 1: Add three off-variant SVG constants alongside the existing ones**

Insert these constants directly after `EMPTY_CAMERA_SVG` (around line 45):

```ts
const CAMERA_OFF_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.5" y="6.5" width="13" height="11" rx="1.5"/>
  <path d="M15.5 10.5l5.5-3v9l-5.5-3z"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`;

const SHARE_OFF_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
  <circle cx="12" cy="12" r="3"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`;

const MIC_OFF_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <rect x="9" y="3" width="6" height="12" rx="3"/>
  <path d="M5 11a7 7 0 0 0 14 0"/>
  <line x1="12" y1="18" x2="12" y2="22"/>
  <line x1="8.5" y1="22" x2="15.5" y2="22"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`;
```

The slash uses `currentColor` like the rest of the stroke, so CSS color rules drive both the icon and the slash uniformly.

- [ ] **Step 2: Run the build to confirm no type/parse error**

Run: `npm run build`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/hud/components/VideoPanel.ts
git commit -m "feat(hud): add slashed-icon SVGs for camera/share/mic off-state"
```

---

### Task 2: Teach `makeToolbarButton` to swap icons by state

**Files:**
- Modify: `src/hud/components/VideoPanel.ts:315-329` (the `makeToolbarButton` helper)

- [ ] **Step 1: Replace the helper with a version that takes `iconOn` + `iconOff` and renders both, hiding one via a class**

Replace the existing `makeToolbarButton` function (currently at the bottom of the file) with:

```ts
function makeToolbarButton(opts: {
  label: string;
  title: string;
  iconOn: string;
  iconOff: string;
  onClick: () => void;
}): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'video-panel-toolbar-btn';
  btn.title = opts.title;
  btn.setAttribute('aria-label', opts.label);
  // Both icons live in the DOM at once; CSS shows the correct one based on
  // whether the button has the `.enabled` class. Avoids re-parsing innerHTML
  // on every toggle.
  btn.innerHTML = `
    <span class="icon icon-on">${opts.iconOn}</span>
    <span class="icon icon-off">${opts.iconOff}</span>
    <span>${opts.label}</span>
  `;
  btn.addEventListener('click', opts.onClick);
  return btn;
}
```

- [ ] **Step 2: Update the three `makeToolbarButton` callsites to pass both icons**

In `buildLocalControls` (currently `VideoPanel.ts:110-127`), change each call to use `iconOn` + `iconOff`:

```ts
this.cameraButton = makeToolbarButton({
  label: 'Camera',
  title: 'Turn on your camera so the game can track your hands.',
  iconOn: CAMERA_SVG,
  iconOff: CAMERA_OFF_SVG,
  onClick: () => { for (const l of this.cameraListeners) l(); },
});
this.shareButton = makeToolbarButton({
  label: 'Share Video',
  title: 'Optional — let your partner see your camera feed.',
  iconOn: SHARE_SVG,
  iconOff: SHARE_OFF_SVG,
  onClick: () => { for (const l of this.shareVideoListeners) l(); },
});
this.micButton = makeToolbarButton({
  label: 'Mic',
  title: 'Optional — let your partner hear you.',
  iconOn: MIC_SVG,
  iconOff: MIC_OFF_SVG,
  onClick: () => { for (const l of this.micListeners) l(); },
});
```

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/hud/components/VideoPanel.ts
git commit -m "refactor(hud): toolbar buttons render both on/off icons, swap via CSS"
```

---

### Task 3: Restyle the toolbar buttons — strong off-state

**Files:**
- Modify: `src/hud/style.css:635-716` (the `.video-panel-toolbar-btn` rules and `.enabled` variant)

- [ ] **Step 1: Update the off-state base rule and add icon-swap rules**

Replace the existing `.video-panel-toolbar-btn`, `.video-panel-toolbar-btn:hover`, and `.video-panel-toolbar-btn.enabled` rules (lines 635–674) with:

```css
.video-panel-toolbar-btn {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 12px 7px;
  min-width: 76px;
  background: linear-gradient(180deg, #3a2812 0%, #2a1d10 100%);
  border: 1px solid var(--brass-3);
  color: var(--danger);
  font-family: 'IM Fell English SC', serif;
  font-size: 10px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  cursor: pointer;
  border-radius: 3px;
  opacity: 1;
  transition:
    opacity 0.18s ease, color 0.18s ease, background 0.18s ease,
    border-color 0.18s ease, box-shadow 0.18s ease;
  box-shadow:
    inset 0 -1px 0 rgba(0, 0, 0, 0.55),
    0 2px 4px rgba(0, 0, 0, 0.5);
}
.video-panel-toolbar-btn:hover {
  background: linear-gradient(180deg, #4a3218 0%, #2f2114 100%);
  border-color: var(--brass-2);
}
.video-panel-toolbar-btn.enabled {
  color: var(--sun);
  background: linear-gradient(180deg, #8a6328 0%, #4d3618 100%);
  border-color: rgba(246, 179, 51, 0.55);
  box-shadow:
    inset 0 1px 0 rgba(246, 179, 51, 0.40),
    inset 0 -1px 0 rgba(0, 0, 0, 0.55),
    0 0 12px rgba(246, 179, 51, 0.32),
    0 2px 4px rgba(0, 0, 0, 0.5);
}

/* Icon swap: show the slashed variant when off, the normal one when enabled.
   Both icons inherit currentColor so the slash matches the label tint. */
.video-panel-toolbar-btn .icon-on  { display: none; }
.video-panel-toolbar-btn .icon-off { display: inline-flex; }
.video-panel-toolbar-btn.enabled .icon-on  { display: inline-flex; }
.video-panel-toolbar-btn.enabled .icon-off { display: none; }
.video-panel-toolbar-btn .icon { line-height: 0; }
```

- [ ] **Step 2: Update the SVG sizing rule so it targets the inner SVG inside `.icon`**

Find the existing rule (currently at `style.css:679-682`):

```css
.video-panel-toolbar-btn svg {
  width: 20px;
  height: 20px;
}
```

It already matches descendant SVGs so no change is required, but add a sanity rule right after it to keep the icon spans from collapsing weirdly:

```css
.video-panel-toolbar-btn .icon svg {
  display: block;
}
```

- [ ] **Step 3: Update the `data-stage="share"` reveal rules so the new transitioned property `opacity: 0.85` becomes `opacity: 1`**

Find lines 703–712 (the `.share-revealed .video-panel-toolbar-btn[data-stage="share"]` rule). Change `opacity: 0.85;` to `opacity: 1;` so the off-state stays at full opacity once revealed (consistent with the new no-fade design):

```css
.video-panel-toolbar.share-revealed .video-panel-toolbar-btn[data-stage="share"] {
  opacity: 1;
  transform: translateY(0) scale(1);
  pointer-events: auto;
  width: auto;
  min-width: 76px;
  padding: 8px 12px 7px;
  margin-left: 0;
  border-width: 1px;
}
```

The trailing `:hover` / `.enabled` rule on lines 713–716 can be deleted — it's no longer needed since the base rule already sets `opacity: 1`. Delete:

```css
.video-panel-toolbar.share-revealed .video-panel-toolbar-btn[data-stage="share"]:hover,
.video-panel-toolbar.share-revealed .video-panel-toolbar-btn[data-stage="share"].enabled {
  opacity: 1;
}
```

- [ ] **Step 4: Run the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 5: Visually verify in the browser**

Run: `npm run dev`
Open the app. With the local video panel visible:
- Off Camera button should look distinctly "off": dark brown background, red slash through the camera icon, red label.
- Tap Camera — Share Video and Mic buttons appear, also in red/slashed/dark state.
- Tap Share Video / Mic — they switch to the gold "enabled" look with the un-slashed icon.
- Toggling back returns to the red slashed look.

- [ ] **Step 6: Commit**

```bash
git add src/hud/style.css
git commit -m "feat(hud): clearer toolbar off-state — red slashed icons, no warm tint"
```

---

### Task 4: Add the share-warn ribbon overlay (DOM + state)

**Files:**
- Modify: `src/hud/components/VideoPanel.ts` — add ribbon SVG constant, ribbon builder, state fields, presence setter, recompute helper, hook into existing camera/share setters.

- [ ] **Step 1: Add a slashed-eye SVG constant for the ribbon**

Place near the other `*_OFF_SVG` constants:

```ts
const PARTNER_BLIND_SVG = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
  <circle cx="12" cy="12" r="3"/>
  <line x1="3" y1="3" x2="21" y2="21"/>
</svg>`;
```

- [ ] **Step 2: Add private state fields and the ribbon element to the class**

In `VideoPanel` (top of class, where the other private fields live around lines 47–66), add:

```ts
private shareWarnOverlay?: HTMLDivElement;
private cameraEnabled = false;
private shareVideoEnabled = false;
private partnerPresent = false;
```

- [ ] **Step 3: Add a `buildShareWarnOverlay` method, called from the constructor's local-mode branch**

Right after `this.buildEmptyOverlay();` in the constructor (around line 87), add:

```ts
this.buildShareWarnOverlay();
```

Then add the method itself (place it next to `buildEmptyOverlay` around line 143):

```ts
private buildShareWarnOverlay(): void {
  const ribbon = document.createElement('div');
  ribbon.className = 'video-panel-share-warn hidden';
  ribbon.innerHTML = `
    <div class="icon">${PARTNER_BLIND_SVG}</div>
    <div class="heading">PARTNER CAN'T SEE YOU</div>
    <div class="subhead">Tap Share Video to share your camera</div>
  `;
  this.wrapper.appendChild(ribbon);
  this.shareWarnOverlay = ribbon;
}
```

- [ ] **Step 4: Add `setPartnerPresent` and a private `recomputeShareWarn` helper**

Add these two methods inside the class (group them with the other `set*Enabled` methods, around line 165):

```ts
setPartnerPresent(present: boolean): void {
  if (this.mode !== 'local') return;
  this.partnerPresent = present;
  this.recomputeShareWarn();
}

private recomputeShareWarn(): void {
  if (!this.shareWarnOverlay) return;
  const visible =
    this.partnerPresent && this.cameraEnabled && !this.shareVideoEnabled;
  this.shareWarnOverlay.classList.toggle('hidden', !visible);
}
```

- [ ] **Step 5: Update `setCameraEnabled` and `setShareVideoEnabled` to track state and recompute**

Replace the existing `setCameraEnabled` and `setShareVideoEnabled` methods (currently `VideoPanel.ts:156-169`) with:

```ts
setCameraEnabled(enabled: boolean): void {
  this.cameraEnabled = enabled;
  this.cameraButton?.classList.toggle('enabled', enabled);
  this.emptyOverlay?.classList.toggle('hidden', enabled);
  this.toolbar?.classList.toggle('share-revealed', enabled);
  if (this.hintEl) {
    this.hintEl.textContent = enabled
      ? 'Want your partner to see and hear you? Toggle Share Video / Mic →'
      : 'Tap Camera to track your hands · You can play without it with mouse/trackpad';
  }
  this.recomputeShareWarn();
}

setShareVideoEnabled(enabled: boolean): void {
  this.shareVideoEnabled = enabled;
  this.shareButton?.classList.toggle('enabled', enabled);
  this.recomputeShareWarn();
}
```

`setMicEnabled` does not need changes — mic state doesn't drive the ribbon.

- [ ] **Step 6: Run the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/hud/components/VideoPanel.ts
git commit -m "feat(hud): add share-warn ribbon overlay + presence-aware visibility logic"
```

---

### Task 5: Style the share-warn ribbon

**Files:**
- Modify: `src/hud/style.css` — append rules after the `.video-panel-empty` block (around line 784).

- [ ] **Step 1: Append the new CSS block**

Add directly after the closing brace of `.video-panel-empty .hint` (around line 784, before the `/* Share button + popover */` section):

```css
/* "Partner can't see you" ribbon — shown over the local video preview when
   a partner is in the room and Share Video is off. The ribbon spans the
   panel width but only ~28% of the height so the user still sees their
   own preview above and below. */
.video-panel-share-warn {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  min-height: 28%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 10px 14px;
  text-align: center;
  background: rgba(0, 0, 0, 0.7);
  border-top: 1px solid var(--brass-2);
  border-bottom: 1px solid var(--brass-2);
  pointer-events: none;
  z-index: 4;
  opacity: 1;
  transition: opacity 0.2s ease;
}
.video-panel-share-warn.hidden {
  opacity: 0;
  pointer-events: none;
}
.video-panel-share-warn .icon {
  color: var(--danger);
  line-height: 0;
}
.video-panel-share-warn .icon svg {
  width: 22px;
  height: 22px;
}
.video-panel-share-warn .heading {
  font-family: 'IM Fell English SC', serif;
  font-size: 12px;
  letter-spacing: 0.22em;
  color: var(--danger);
}
.video-panel-share-warn .subhead {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  color: var(--parchment);
  letter-spacing: 0.04em;
}
```

Note on `.hidden`: the existing convention in this file uses `display: none` for `.hidden` (e.g. `.video-panel.hidden`, `.video-panel-empty.hidden`). The ribbon intentionally diverges so the fade transition can run — hidden = `opacity: 0` instead. The element stays in layout but is invisible and non-interactive.

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/hud/style.css
git commit -m "feat(hud): style for share-warn ribbon overlay"
```

---

### Task 6: Wire partner presence from `Hud` to the local panel

**Files:**
- Modify: `src/hud/Hud.ts:241-246` (the `setPartner` method).

- [ ] **Step 1: Forward the presence flag to the local panel**

Replace the existing `setPartner`:

```ts
setPartner(name: string | null): void {
  this.partnerName = name;
  this.partnerPresent = !!name;
  this.applyPlaques();
  this.renderNetRow();
  this.localPanel.setPartnerPresent(this.partnerPresent);
}
```

- [ ] **Step 2: Run the build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 3: Visually verify the full flow in the browser**

Run: `npm run dev`. Open two browser windows in the same room.
- Before the second client joins: ribbon is hidden in window A (no partner present).
- Window B joins: in window A, if camera is on and share-video is off, the ribbon fades in.
- In window A, tap Share Video on: ribbon fades out.
- In window A, tap Share Video off: ribbon fades back in.
- In window A, turn camera off: the existing "Camera Off" placeholder takes over; the ribbon stays hidden (it's behind the placeholder, but visibility logic should also have suppressed it).
- Window B leaves / refreshes: ribbon fades out in window A.

- [ ] **Step 4: Commit**

```bash
git add src/hud/Hud.ts
git commit -m "feat(hud): forward partner presence to local panel for share-warn ribbon"
```

---

## Self-review

**Spec coverage:**
- Toolbar off-state restyle (icon swap + color + opacity + dropped glow) → Tasks 1, 2, 3.
- Share-warn ribbon DOM + visibility rule → Task 4.
- Ribbon styling → Task 5.
- Wiring through `Hud.setPartner` → Task 6.
- Reuses existing `--danger` (verified present in `style.css:17`) instead of introducing the `--alert` variable from the spec — DRY win, palette-consistent. (This is the one deviation from the spec; updated to reflect actual codebase.)

**Placeholder scan:** No TBDs, TODOs, "implement later," or vague guidance. Every code change shows the full code.

**Type/name consistency:** `setPartnerPresent`, `recomputeShareWarn`, `buildShareWarnOverlay`, `shareWarnOverlay`, `cameraEnabled`, `shareVideoEnabled`, `partnerPresent` — used identically across Tasks 4 and 6. CSS class `.video-panel-share-warn` used consistently between Tasks 4 and 5.

**Build verification:** Each code-changing task ends with `npm run build` (which runs `tsc --noEmit && vite build`) before commit.
