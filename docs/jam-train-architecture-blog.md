# How Jam Train Works: Multiplayer Hands, Peer-to-Peer Motion, and a GPU Energy Sculpture

Jam Train is a browser-based music toy disguised as a tiny train cabin. You move your hands, the puppets move with you, the instruments react, sound plays, and colored particles fly into a shared sculpture in the center of the scene. If another person joins the same room, their hands and instrument appear across the table.

Under the surface, it is also a compact tour of several useful systems:

- realtime browser rendering with Three.js and WebGPU
- webcam hand tracking
- audio synthesis with Tone.js
- room presence and matchmaking with SpacetimeDB
- peer-to-peer media and pose transport with WebRTC
- GPU particle simulation using mathematical flow fields

The interesting part is not just that these pieces exist. It is how the project separates them. Slow, durable multiplayer state goes through the server. Fast, throwaway motion goes peer-to-peer. Instruments do not know whether hands came from a webcam, mouse, robot, or remote player. The energy sculpture does not know about hands at all. It only receives bursts of particles.

That separation is what makes the system teachable.

## The Runtime Shape

The app starts in `src/main.ts`. The intro screen loads first, then the heavier runtime is imported lazily so the first visual transition is not blocked by WebGPU, audio, hand tracking, and networking setup.

Once the runtime is ready, `main.ts` creates two major objects:

- `Hud`, which owns the visible interface
- `Game`, which owns the Three.js scene, render loop, hand tracking, audio, multiplayer, instruments, and sculpture

The game loop lives in `Game.update()`. On every frame it performs a sequence like this:

```text
advance round timer
read local hand pose
read remote pose, or use robot fallback
update local and remote puppet rigs
update active instruments
update the energy sculpture
update scenery and atmosphere
update audio engines
send local pose to the partner
render the scene
```

That loop is the heart of the application. Everything else either feeds data into it or reacts to data coming out of it.

## The Most Important Design Choice: Two Kinds of Networking

The multiplayer system uses two different networking technologies because it has two different kinds of data.

Some data is low frequency and needs a source of truth:

- Which room am I in?
- What is my display name?
- Which seat am I assigned?
- Which instrument did I choose?
- Which creature/puppet did I choose?
- Who is my partner?

That data goes through SpacetimeDB.

Other data is high frequency and only matters while it is fresh:

- Where are my hands right now?
- What is my camera video stream?
- What is my mic audio stream?

That data goes through WebRTC.

This is a very common realtime architecture pattern. Use the server for coordination and truth. Use peer-to-peer transport for live media and transient motion.

## SpacetimeDB as the Room Server

The server module lives in `spacetimedb/src/index.ts`. Its main table is `player`, which stores one row per connected identity:

```text
identity
roomId
displayName
seatIndex
online
instrument
creature
connectedAt
updatedAt
```

There is also a `webrtc_signal` table used for temporary WebRTC setup messages. It is not used for video, audio, or pose streaming. It only helps two browsers find each other and negotiate a direct connection.

When the client connects, `MultiplayerClient` calls the `request_seat` reducer. That reducer decides which room the player should join:

1. If the URL requested a room and it has fewer than two online players, use it.
2. Otherwise, find a room with exactly one online player and auto-pair.
3. Otherwise, create or reuse a fallback room name.

The reducer also assigns seat `0` or `1`, stores the display name, and records the selected instrument and creature.

One subtle design choice: disconnects do not delete player rows. The server marks a player `online: false`. That prevents every page reload from looking like a dramatic leave and rejoin. It also lets the same browser tab reconnect with the same identity token.

That is a good example of designing around real network behavior. Browsers refresh, laptops sleep, Wi-Fi drops, and users switch tabs. A multiplayer app should treat short disconnects as normal.

## WebRTC as the Live Transport

WebRTC is the browser technology built for peer-to-peer audio, video, and realtime data. But two browsers cannot usually connect directly without first exchanging setup information.

That setup information is called signaling. Jam Train sends signaling messages through SpacetimeDB:

```text
offer
answer
ICE candidate
```

Once the offer/answer/ICE exchange succeeds, the actual WebRTC connection is peer-to-peer.

The client code for this is in `src/game/webrtc.ts`.

There are several important networking ideas packed into that file.

First, the app chooses one peer to create the offer. It does this deterministically: the lower SpacetimeDB identity string becomes the offerer. Both clients can make the same decision independently, which avoids a race where both sides try to offer at the same time.

Second, it implements a version of the "perfect negotiation" pattern. If an offer collision still happens, one peer is polite and can yield; the other is impolite and ignores the colliding offer. This is defensive programming for asynchronous networks.

Third, pose messages go over a WebRTC data channel configured as unordered and unreliable:

```text
ordered: false
maxRetransmits: 0
```

That sounds risky until you think about the data. A hand pose from 200 ms ago is not valuable. If a pose frame gets lost, the next frame replaces it. This is the same basic reason many games send motion updates over UDP-style unreliable channels. Freshness beats guaranteed delivery.

The project currently uses a public STUN server but no TURN server. STUN helps peers discover connection paths through NAT. TURN relays traffic when direct paths fail. Without TURN, some restrictive networks will connect to SpacetimeDB just fine but fail to establish WebRTC media. That is a normal tradeoff for a prototype or lightweight experience.

## Pose Transport: Same Shape, Many Sources

The shared pose type lives in `src/game/types.ts`. A `PlayerPose` contains:

- player id
- room id
- seat index
- left and right hands
- wrist, palm, and finger joint positions
- an energy value
- timestamp

The local player pose can come from webcam hand tracking or from mouse simulation. The remote pose can come from WebRTC or from a same-browser `BroadcastChannel` used for local tab testing. If no real partner is present, a procedural robot generates the partner pose.

The useful abstraction is this:

```text
camera, mouse, WebRTC, BroadcastChannel, robot
              |
              v
          PlayerPose
              |
              v
        rigs, instruments, audio
```

After data becomes a `PlayerPose`, the rest of the app does not need to know its origin.

`PoseSession` sends local poses at about 30 Hz. It fans the same pose out through every available transport, accepts inbound poses from any transport, ignores its own id, and keeps the latest remote pose. That is a small but effective realtime state manager.

## Hands Become Puppets, Contacts, and Sound

The `HumanoidRig` turns abstract pose coordinates into world-space puppet joints. It also exposes world-space palm and finger positions.

Instruments consume those world-space contacts. That is another useful boundary:

```text
pose data -> rig -> world-space contacts -> instrument hits
```

The drum instrument is a pyramid of playable orbs. It uses a point BVH, from `three-mesh-bvh`, to quickly find which orb a palm or finger might have hit. Without that, every frame would require checking every contact point against every orb. With a BVH, the instrument can ask, "which orb centers are near this swept hand segment?"

The starlace instrument is a 3D constellation. Its nodes are connected into a sparse graph, and plucks can come from hand contact, pointer motion, or keyboard paths that walk across the graph.

Both instruments trigger audio. Both also emit energy into the central sculpture.

## The Energy Sculpture Is a Particle System, Not a Mesh

The central sculpture lives in `src/game/EnergySculptor.ts`. It is the most conceptually rich part of the project.

The instruments do not directly create visible particles. They call a tiny API:

```text
emit({
  kind,
  origin,
  direction,
  color,
  count,
  speed
})
```

Those emit requests are CPU-side events. The sculpture collects them for the current frame, writes them into a fixed-size spawn queue, and dispatches WebGPU compute passes.

The particle pool contains tens of thousands of particles. Each particle has:

- position
- velocity
- color
- age and lifetime
- smoothed acceleration
- alpha

Those values live in GPU storage buffers, created through Three.js TSL `instancedArray` nodes. That means the CPU is not iterating through 24,000 particles every frame. The GPU updates them in parallel.

The sculpture uses two compute passes:

1. Emit pass: place new particles into dead slots.
2. Integrate pass: update every alive particle through the active field.

Then the particles render as instanced additive sprites. They are small billboards, not individual sphere meshes. Their color brightens with speed, their scale fades with lifetime, and their shape stretches with acceleration.

This is why the sculpture can be dense and fluid without turning into a CPU bottleneck.

## What Is a Particle Field?

A field is a function that assigns a value to every point in space.

A temperature field says:

```text
position -> temperature
```

A wind field says:

```text
position -> wind velocity
```

Jam Train's energy sculpture uses a velocity field:

```text
position -> particle velocity
```

For every particle, each frame, the shader asks:

```text
At this particle's current position, what direction does the field want it to move?
```

Then it blends the particle's velocity toward that desired velocity.

That is what makes the sculpture feel like a living flow rather than a cloud of random sparks.

## Strange Attractors as Musical Sculpture

The velocity fields come from strange attractors, implemented in `src/game/sculptor/strangeAttractors.ts`.

Strange attractors are mathematical systems where simple equations produce complex, bounded, often chaotic motion. They are famous because they can look organic even though they are deterministic.

Jam Train includes several:

- Thomas: a gentle wandering yarn-ball flow
- Lorenz: the classic butterfly-shaped attractor
- Aizawa: nested toroidal shells
- Halvorsen: tangled symmetric plasma
- Rossler: a spiraling band
- Dadras: asymmetric woven ribbons

The active instrument pairing can map to different attractors:

```text
drum + drum       -> Lorenz
starlace + starlace -> Thomas
drum + starlace   -> Aizawa
```

There is also a tweakpane override that can pin the attractor manually. In the current source, the default override is `thomas`, so automatic pairing-based attractor switching only takes over after the override is set to `auto`.

That is a nice example of how creative coding tools often expose both authored behavior and live debug control.

## How Particles Enter the Sculpture

When a drum orb is hit, it emits a burst of particles from the strike point. When a starlace node is plucked, it emits a streak from the node.

The spawn code does not aim every particle at the exact center. It creates a small launch disk, adds jitter, chooses a target region inside the active field, and seeds velocity toward that target. For Thomas, it even precomputes points along the attractor so particles can enter the lobes quickly.

After spawning, the field takes over.

That distinction matters:

- emission gives the particle a musical origin
- the field gives it sculptural behavior
- lifetime controls whether it keeps flowing or settles into a record of past events

The result is a sculpture that is not just an effect attached to a hit. It accumulates the history of play.

## Rounds, Dissolve, and the Projector Ring

`RoundDirector` exists to cycle the sculpture through phases:

```text
playing -> dissolving -> playing
```

The sculpture has support for dissolve mode. In dissolve mode, particles get an outward burst and age faster, making the current sculpture clear out for the next round.

There is also a set of decorative projector rings around the sculpture base, plus a synchrony ring that fires when drum and starlace events happen close together.

One implementation note: the design docs describe a full round transition, but the current `RoundDirector.tick()` does not yet transition from `playing` to `dissolving` when `roundDuration` is reached. The sculpture has the dissolve hooks, and `Game` wires them, but the round state machine is missing that edge.

That is a useful reminder when reading codebases: docs and code can drift. The runtime source is the truth.

## Why the Architecture Works

The project has a strong "data shape first" design.

Hands become poses. Poses become rig joints. Rig joints become contacts. Contacts become instrument events. Instrument events become audio and particle emissions. Particle emissions become GPU state. GPU state becomes a visible sculpture.

Each layer has a focused job:

```text
HandTracker: input
PoseSession: pose transport
HumanoidRig: pose to world-space body
Drum/Starlace: interaction and musical events
HandSynthEngine: sound
EnergySculptor: particle simulation and sculpture
MultiplayerClient: server-backed room state
WebRTCClient: peer media and realtime data
Hud: controls and status
```

That makes the system easier to reason about. If remote hands stop moving, you look at pose transport. If names or rooms are wrong, you look at SpacetimeDB state. If particles do not appear, you inspect instrument emits and sculptor spawn queues. If particles appear but do not move correctly, you inspect the GPU integration field.

## What This Teaches

Jam Train is a useful learning codebase because it compresses several real software lessons into a playful artifact.

Networking lesson: not all data wants the same transport. Presence wants a server. Live pose wants low-latency peer transport. Old pose frames should be dropped, not preserved.

Rendering lesson: a large particle system should not be a large pile of JavaScript objects. Keep state in buffers, update it on the GPU, and render it with instancing.

Interaction lesson: normalize input early. Once webcam, mouse, robot, and network data all become the same pose type, instruments and audio do not need special cases.

Systems lesson: a good creative system is still a system. The magic comes from clean boundaries, not from everything knowing about everything else.

The central sculpture is the best metaphor for the app itself. Each subsystem contributes a small, understandable stream of data. The final experience emerges from how those streams flow together.
