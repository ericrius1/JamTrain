# Creatures — Design

**Date:** 2026-04-26

## Problem

Every player in the train is the same humanoid rig: capsule body, sphere head, eyes-and-mouth face, primitive cloth color. Two issues:

1. **No identity beyond color.** "What you are" is reduced to a per-seat hex value. Players can't express anything else about themselves.
2. **The current rig is cartoony in the wrong way** — primitives stuck together, flat-shaded `MeshStandardMaterial`, no secondary forms or considered shading. It's the visual outlier in a project whose other surfaces (sky, plasma, sparks, scenery) are TSL-driven and carefully composed.

## Goals

- Players choose what creature they are. Two species at launch: **lion** (default, new) and **human** (rebuilt at higher craft).
- Selection happens **after** the player is in the train, not at the intro screen. The picker is in the HUD, on the existing `PlayerPlaque` medallion.
- Selection syncs across the multiplayer session (per-player), persists locally, mirrors the `instrument` sync pattern.
- Both creatures share **one redesigned humanoid rig** with compound forms, considered proportion, and TSL-composed stylized shading. The lion is anthropomorphic — same skeleton, swapped head + mane + tail + fur tone — so pose tracking, palm anchors, and instrument visuals work unchanged.
- The new rig replaces the old one; the old `MeshStandardMaterial`-based rig is the legacy outlier and goes away.

## Non-goals

- **No quadrupedal lion.** Lion is anthropomorphic. Pose tracking is humanoid-only.
- **No additional species in this work.** The registry is shaped to grow, but lion + human is the full deliverable.
- **No costume/customization beyond species choice.** No mane-color picker, no eye color, no fur pattern variation. Per-seat color drives the lion's mane and the human's tunic — that's the only color knob.
- **No re-rig of the pose pipeline.** `PlayerPose`, `PoseSession`, hand mapping, and `getPalmWorld()` stay as-is. The new rig consumes pose the same way.
- **No on-creature instrument re-skin.** Instrument visuals (Ribbon, Bloom, Sparks) keep their existing look; they just anchor between the new palms.

---

## Aesthetic target

Stylized in the lineage of *Sky: Children of the Light* / *Journey* / a Pixar short — clean sculpted forms with deliberate proportion and considered light, not primitives stuck together. Still fully procedural Three.js geometry, no imported models. The win is **shape continuity, secondary forms, and shading** — not poly count.

### Five craft moves

1. **Compound forms, not single shapes.** Heads, torsos, and limbs are composed from multiple blended primitives so silhouettes read as bodies, not stacks.
2. **Gestural proportion.** Subtle forward tilt, dropped shoulders, a waist taper, hands that hang with a small bend. Asymmetries on the order of a few degrees read as "alive."
3. **Real eyes.** Recessed sockets with a sclera + iris + dark pupil + a fixed specular catch. Single biggest readability lift.
4. **TSL-composed stylized shading.** No PBR, no `onBeforeCompile`. A shared `creatureColorNode` Fn implements the lighting model directly: half-Lambert key, warm rim, cool ambient floor, fake-SSS back-light for skin/fur.
5. **Micro-life animation.** Breathing scale on the torso, occasional eye blink, idle head sway, mane tuft drift, tail swish. All time-driven via TSL `time` or per-frame transform updates.

---

## The two creatures

Both creatures share a single humanoid skeleton (`HumanoidRig`) with the same bones, palm anchors, and pose-update contract. They differ in **head construction**, **body color/material**, and **species accessories** (mane, tail).

### Human

| | |
|---|---|
| **Head** | Egg-shaped cranium (lathed) + softer jaw mass + brow ridge curving over the eye line + small nose ridge. Recessed eye sockets with sclera + iris + pupil + TSL specular catch. Soft mouth as a thin curved arc. |
| **Body** | Upper torso (lathed cone) + slimmer waist + soft neck + shoulder spheres. Tunic-style cloth layer slightly offset, flares at the hip, tinted by per-seat color. |
| **Limbs** | Tapered lathed upper arm + forearm; refined fingers with knuckle-blend spheres between segments. Same finger structure as today. |
| **Material roles** | `skin` (skinColorNode), `cloth` (clothColorNode tinted by seat color), `eye` (eyeColorNode), `accent` (small palm/wrist node glow). |

### Lion (default)

| | |
|---|---|
| **Head** | Domed skull + forward-extruded snout block tapering to a small dark nose pad + upper-lip curve + tufted cheeks (a few small instanced cones, slight per-tuft randomization seeded by player identity) + pointed ears (cone with a hollowed inner cone). Same eye treatment as human. |
| **Mane** | Instanced corona of ~48 short tufts (low-poly cones) arranged around the head/neck in two passes — inner darker, outer lit by per-seat color. Per-tuft scale/angle/length jittered with a seeded hash. Tufts drift on a TSL time-driven sway. |
| **Body** | Same skeleton as human. Cloth layer is a tawny fur tone (no tunic). Per-seat color shows up in the mane only. |
| **Tail** | `TubeGeometry` along a smooth curve off the lower back, with a small tuft at the end. Sways on a low-frequency sin curve in the TSL color path or a transform update — whichever is cleaner. |
| **Material roles** | `fur` (furColorNode, tawny base + subtle hash-driven fiber variation), `mane` (maneColorNode tinted by seat color), `eye`, `accent`. |

---

## Shared rig: `HumanoidRig`

A single class replaces the current `PlayerRig`. Same external API (constructor takes `{ seatIndex, color, creature }`, exposes `update(pose, delta, robotTarget)`, `getPalmWorld(hand)`, `dispose()`), so consumers (`Game`, instrument visuals) don't change.

Internally it composes:

- A **skeleton** module that owns transforms (head, torso, arms, hands, fingers). Identical for both creatures.
- A **head** module chosen by creature: `HumanHead` or `LionHead`. Both expose the same anchor points (top-of-head, eye centers, etc.) so tail/mane/accessories that hang off the skull know where to attach.
- An **accessories** module — only present for lion (mane + tail) — driven by the same time tick as the skeleton update.
- A **materials** module that builds the per-creature material set from the shared TSL color nodes, parameterized by seat color.

The previous `robot?: boolean` overlay blend on `PlayerRig` is dropped. Robot styling was vestigial and not exposed in the UI; removing it simplifies the material set. (If it ever returns, it'll be its own creature.)

---

## TSL-composed shading

A new `src/game/creatureShading.ts` exports a single composable Fn factory:

```ts
creatureColorNode({
  baseColor,        // ColorNode — tint per material role
  rimColor,         // ColorNode — warm edge color
  rimStrength,      // FloatNode
  sssColor,         // ColorNode — back-light tint, near-zero for cloth/eye
  sssStrength,      // FloatNode
  ambientCool,      // ColorNode — cool floor color in shadow
  keyDir,           // Vec3 uniform — fixed scene key direction
  fiberHashStrength // FloatNode — 0 for skin/cloth, small >0 for fur
}) => colorNode
```

Inside, it composes:

- **Half-Lambert key:** `normalWorld.dot(keyDir).mul(0.5).add(0.5)` smoothstepped into a soft toon ramp, multiplied into `baseColor`.
- **Cool ambient floor:** `mix(ambientCool, baseLit, halfLambert)` so shadows aren't black, they're cool-desaturated.
- **Warm rim:** `pow(float(1).sub(normalWorld.dot(viewDir).abs()), rimPower).mul(rimStrength)` added with `rimColor`.
- **Fake SSS back-light:** dot against a fixed warm back direction, fading at fresnel edges, scaled by `sssStrength` and added with `sssColor`.
- **Fiber hash variation:** when `fiberHashStrength > 0`, a `hash(positionLocal)` adds a tiny per-fragment color jitter for fur readability.

Per-role materials are thin wrappers picking the right uniforms:

- `skinColorNode` — peach `baseColor`, moderate SSS, no fiber hash.
- `clothColorNode` — seat color `baseColor`, no SSS, stronger half-Lambert.
- `furColorNode` — tawny `baseColor`, gentle SSS, small fiber hash.
- `maneColorNode` — seat-color-tinted golden `baseColor`, gentle rim, slightly stronger fiber hash.
- `eyeColorNode` — separate simpler Fn: dark sclera base, iris ring via radial UV, computed specular catch via `reflect(viewDir, normalWorld).dot(specDir)` thresholded to a bright dot.
- `accentColorNode` — emissive cyan glow for palm/wrist nodes (instrument anchor points), unchanged role from current rig.

All materials are `MeshBasicNodeMaterial` from `three/webgpu`, with `colorNode` set to the appropriate Fn output. No `MeshStandardMaterial` anywhere in the rig.

---

## Selection + multiplayer sync

Mirrors the existing `instrument` pattern from `multiplayer.ts` and `spacetimedb/src/index.ts` exactly.

### UX

The existing `PlayerPlaque` medallion (top-corner HUD, currently a static visual indicator) becomes a clickable creature picker for the **local** player only. Click → small popover floats below the medallion with two icon buttons: lion and human. Clicking an option:

- Updates local state immediately and re-skins the local rig in place (no respawn — head/accessories swap, materials swap, body geometry stays).
- Calls `update_creature` on SpacetimeDB.
- Closes the popover.

The medallion icon itself reflects the current creature (lion silhouette or human silhouette) so the player can see what they are at a glance.

For the **partner**, the medallion in their `PlayerPlaque` is read-only and shows their current creature; clicking it does nothing (no popover).

### Persistence

- **Local:** `localStorage` key `jamtrain.creature`, written on each pick. On next session load, the stored value seeds `localCreature` before SpacetimeDB connects.
- **Multiplayer:** new `creature: t.string()` column on the `player` table.

### Resolution between local and server on connect

When `acceptOwnPlayer()` resolves and we see our own server row for the first time:

- If `localStorage` has a stored creature, the **local value wins** — the client immediately calls `update_creature` to push it to the server, and fires `onLocalCreatureChange` so the rig re-skins to that creature. The server's `'lion'` default from `request_seat` is treated as a placeholder, not an authoritative value.
- If `localStorage` is empty, the client adopts the server row's value (which will be `'lion'` for new rows) and writes it back to `localStorage` so subsequent loads are deterministic.
- Subsequent server-side updates (e.g. another tab on the same identity changing creature) flow down normally and overwrite local state.

### Default

- New player with no `localStorage` value → **lion** (matches `request_seat` default).
- Returning player with `localStorage` set → that value, pushed to server on connect.
- No "auto-pick something different from the partner" logic (unlike instruments — different feature, different defaulting story; both players can be lions).

### SpacetimeDB schema change

In `spacetimedb/src/index.ts`, add to the `player` table:

```ts
creature: t.string(), // 'lion' | 'human'
```

New reducer, exact mirror of `update_instrument`:

```ts
const ALLOWED_CREATURES = new Set(['lion', 'human']);

export const update_creature = spacetimedb.reducer(
  { creature: t.string() },
  (ctx, { creature }) => {
    if (!ALLOWED_CREATURES.has(creature)) {
      throw new SenderError(`invalid creature: ${creature}`);
    }
    const row = ctx.db.player.identity.find(ctx.sender);
    if (!row) return;
    ctx.db.player.identity.update({ ...row, creature, updatedAt: ctx.timestamp });
  }
);
```

`request_seat` is updated to insert `creature: 'lion'` as the row default. Client overwrites via `update_creature` if local choice differs.

### Client wiring

In `src/game/multiplayer.ts`, alongside the instrument fields:

- `localCreature: CreatureId` (default `'lion'`, seeded from `localStorage`).
- `partnerCreature: CreatureId` (default `'lion'`, reset on disconnect).
- `setLocalCreature(id)` → updates local state, writes `localStorage`, calls reducer, fires listeners.
- `onLocalCreatureChange(listener)` and `onPartnerCreatureChange(listener)` — fire immediately on subscribe, then on changes.
- `acceptOwnPlayer()` and `updatePartner()` extend to read `creature` from the row and fire change listeners on diffs.

`Game` listens to both, calls `rig.setCreature(id)` on the local rig and `partnerRig.setCreature(id)` on the partner rig. The rig's `setCreature(id)` method swaps head/accessories/materials in place without throwing away the skeleton or the mesh tree root.

---

## Code structure

**New files:**

- `src/game/creatures.ts` — exports `CreatureId`, `CREATURE_IDS`, `CreatureMeta` (id, label, iconSvg), `CREATURES` registry, `isCreatureId` guard. Mirrors `instruments.ts`.
- `src/game/creatureShading.ts` — TSL color-node factories described above.
- `src/game/rig/skeleton.ts` — humanoid skeleton (transforms only, no head/accessories).
- `src/game/rig/humanHead.ts` — human head construction.
- `src/game/rig/lionHead.ts` — lion head + mane construction.
- `src/game/rig/lionTail.ts` — lion tail.
- `src/game/rig/HumanoidRig.ts` — composes skeleton + head + accessories + materials. Public API.
- `src/hud/components/CreaturePicker.ts` — popover with lion/human options. Mounts under the existing `PlayerPlaque` medallion.

**Modified files:**

- `src/game/multiplayer.ts` — add creature state, listeners, reducer call, schema field reads. Mirror of instrument additions.
- `src/game/Game.ts` — wire creature listeners; call `setCreature` on the local + partner rigs. Default rig construction uses `lion`.
- `src/hud/components/PlayerPlaque.ts` — medallion becomes clickable for local; renders creature icon; mounts/unmounts `CreaturePicker` popover. Partner plaque is read-only.
- `src/hud/Hud.ts` — pass current creature into local + partner plaques; subscribe to changes.
- `spacetimedb/src/index.ts` — schema column + `update_creature` reducer + default in `request_seat`.

**Deleted files:**

- `src/game/rig.ts` (replaced by `src/game/rig/HumanoidRig.ts`). Old class along with its `MeshStandardMaterial` set, `robot` overlay, and `*_DEFS` for those materials goes away.

**Generated bindings:** `src/module_bindings/` regenerates from the schema change.

---

## Tweakable params (debug overlay)

Following the existing `*_DEFS` pattern in `tweakDefs.ts`:

- `RIG_DEFS` — proportions: head scale, neck length, shoulder width, waist taper, arm taper, hand scale, breathing amplitude, idle sway amplitude.
- `CREATURE_SHADING_DEFS` — half-Lambert wrap softness, rim power, rim strength, ambient cool tint, SSS strength, key direction (yaw/pitch), back direction (yaw/pitch).
- `LION_DEFS` — mane tuft count, mane inner/outer radius, mane tuft length range, mane sway amplitude, mane sway frequency, tail length, tail tuft size, tail sway amplitude.

Pressing `r` in debug mode resets per existing convention. The old `RIG_DEFS` (if any existed) is replaced.

---

## Performance budget

There are at most 2 player rigs visible at once.

- **Skeleton:** ~50 transforms per rig. Same as today.
- **Geometry per rig:** ~1.5–2× current rig vert count after refining proportions (lathed limbs, compound head). Still well under 10k verts per rig.
- **Lion mane:** 48 instanced cones × ~30 verts each = ~1.5k verts, one instanced draw call.
- **Lion tail:** single TubeGeometry, ~150 verts.
- **Materials:** 4 distinct `MeshBasicNodeMaterial`s per rig at any time (skin/cloth or fur/mane, plus eye and accent), all built from the shared `creatureColorNode` Fn graph.
- **Draw calls per rig:** ~12–15 (was ~20 with old rig due to many separate finger meshes; refactor consolidates where reasonable).

Net: similar or fewer draw calls than today, modest vert increase, gain in visual quality. WebGPU node materials handle this comfortably.

---

## Migration

Single PR, no compatibility shim:

1. Schema column + `update_creature` reducer + bindings regen.
2. `creatures.ts` registry.
3. `creatureShading.ts` TSL nodes.
4. New rig modules under `src/game/rig/`.
5. `multiplayer.ts` creature state + listeners.
6. `Game.ts` wiring.
7. `PlayerPlaque` clickable medallion + `CreaturePicker` popover.
8. Delete old `rig.ts`, update imports.
9. Smoke test: load page, see lion in train; click medallion, swap to human; verify partner sync via second tab.

SpacetimeDB schema migration: this is an additive column change. Per existing dev practice in this project, schema changes are deployed via `spacetime publish` and existing dev rows are cleared as needed. Client code is defensive regardless — `acceptOwnPlayer()` and `updatePartner()` read `row.creature` through `isCreatureId()` and fall back to `'lion'` if the field is absent, empty, or unrecognized.

`localStorage` from prior sessions has no creature key, so all returning players start as lion on first load — desired.

---

## Open risks

- **Lion silhouette readability.** A humanoid lion can read as "person in a costume" if the head is the only difference. Mitigation: tawny body fur (not skin tone), prominent mane, visible tail. If after first build it still reads costume-y, dial the head proportion (longer snout, smaller cranium relative to mane) before considering a quadruped.
- **TSL eye spec catch.** Computing a fixed-direction reflection-based specular dot in TSL across moving heads can drift visually if the dot is too small or too sharp. If it pops in/out as the head turns, fall back to a tiny billboarded white quad anchored to each eye — visually reliable, costs two extra verts per eye.
- **Mane jitter seed stability.** Per-tuft randomization seeded by player identity should be stable across reloads so the same player always looks the same. If the identity isn't available at rig-construction time (e.g. before SpacetimeDB connects), seed from `seatIndex` initially and re-seed once identity arrives — accept the one-time visual snap.
- **Partner rig respawn vs in-place swap.** `setCreature` swapping in place is the right UX (no flicker), but if the head/accessory swap proves fiddly (transform parents, material lifecycle), a clean rebuild — dispose + new rig — is acceptable. Both players will see the partner's rig flash; that's tolerable for the partner's choice.
- **Old tweak persistence.** Any persisted entries under the old `RIG` localStorage key will be orphaned. Harmless; cleared on next `r`-reset per convention.
