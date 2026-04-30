import './style.css';
import { BeginGate } from './hud/components/BeginGate';
import { registerHandposeCacheWorker } from './game/handposeCache';
import { BackingTrackRotation } from './game/BackingTrackRotation';

window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});

const LOCAL_CREATURE_KEY = 'jam-train.local-creature';
const backingTracks = new BackingTrackRotation();
const INITIAL_MULTIPLAYER_SETTLE_MS = 5000;

type AvPrefs = {
  musicVolume: number;
  starlaceVolume: number;
  orbVolume: number;
  backingTrackVolume: number;
  voiceVolume: number;
};

type RuntimeApi = {
  begin: (conductorName: string) => Promise<void>;
  dispose: () => void;
  setConductorName: (name: string) => void;
  exitIntroMode: () => void;
};

const stageWrapEl = document.getElementById('stage-wrap');
if (!stageWrapEl) {
  throw new Error('Jam Train: #stage-wrap mount missing');
}
const stageWrap = stageWrapEl;

const runtimeCanvas = document.querySelector<HTMLCanvasElement>('#scene');
const uiEl = document.getElementById('ui');
stageWrap.classList.add('intro-active');

let activeRuntime: RuntimeApi | undefined;
let runtimePromise: Promise<RuntimeApi> | undefined;
let sceneRevealed = false;

// Pre-warm the browser cache for the assets needed to draw the very first
// frame of the world (train shell + first scenery panel + stored puppets).
// Everything else can lazy-load behind it. We don't await the result before
// constructing the runtime — we just want the bytes in flight by the time
// THREE.TextureLoader asks for them.
const criticalAssetsLoaded = preloadCriticalAssets();

const beginGate = new BeginGate({
  onBegin: async conductorName => {
    // Start the streamed media before awaiting runtime work so the browser
    // sees play() as part of the All Aboard click gesture.
    void backingTracks.playWithFadeIn().catch(err => {
      console.warn('[jam-train] backing track playback failed', err);
    });

    try {
      // Wait for runtime + critical assets so the world we're about to wake
      // up is actually painted. The `await` here is what lets the BeginGate
      // show its "Awakening…" state if the user clicks before the dim scene
      // has appeared behind them.
      const runtime = await loadRuntime();
      await criticalAssetsLoaded;
      runtime.setConductorName(conductorName);
      // Visuals first — kick the dim → bright transition, fade in the HUD,
      // and start the BeginGate crossfade by returning quickly. The audio
      // and multiplayer connect run concurrently so the visuals don't have
      // to wait on networking.
      revealRuntimeSurface();
      runtime.exitIntroMode();
      uiEl?.classList.add('ui-active');
      void runtime.begin(conductorName).catch(err => {
        console.warn('[jam-train] begin failed', err);
      });
    } catch (err) {
      backingTracks.stop();
      throw err;
    }
  },
});
stageWrap.appendChild(beginGate.el);
void registerHandposeCacheWorker();

// Let the intro hit the screen first, then warm the full Three/WebGPU
// runtime. The canvas stays black until createRuntime has rendered a settled
// first frame with the startup loadout applied.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void loadRuntime()
      .then(async () => {
        await criticalAssetsLoaded;
        revealDimmedScene();
      })
      .catch(err => {
        console.warn('[jam-train] runtime preload failed', err);
      });
  });
});

// Static assets needed to draw the very first frame regardless of who's in
// the room. Creature WebPs are intentionally not included — those are
// preloaded after multiplayer sync resolves which two creatures are actually
// active; the rest are lazy-loaded on picker hover/click.
function preloadCriticalAssets(): Promise<void> {
  const urls: string[] = [
    '/cabin/illustrated-cabin-plate-v2-color.webp',
    '/cabin/illustrated-cabin-plate-v2-medium.webp',
    '/cabin/illustrated-cabin-plate-v2-dark.webp',
    '/cabin/illustrated-cabin-plate-v2-alpha.webp',
    '/scenery/far-terrain-chunk-01-alpine-lake.webp',
    '/scenery/far-terrain-chunk-02-fog-forest.webp',
  ];

  return Promise.all(
    urls.map(url => new Promise<void>(resolve => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => resolve();
      img.src = url;
    }))
  ).then(() => undefined);
}

function revealDimmedScene(): void {
  if (sceneRevealed) return;
  if (runtimeCanvas?.classList.contains('scene-active')) return;
  sceneRevealed = true;
  // Two RAFs so the initial opacity:0 is committed before we toggle the
  // class — otherwise the transition can be skipped on first paint.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (runtimeCanvas?.classList.contains('scene-active')) return;
      runtimeCanvas?.classList.add('scene-dim');
      runtimeCanvas?.classList.remove('scene-pending');
    });
  });
}

const marqueeChars = Array.from('🚂 Jam Train ');
let marqueeOffset = 0;
const marqueeTimer = window.setInterval(() => {
  marqueeOffset = (marqueeOffset + 1) % marqueeChars.length;
  document.title =
    marqueeChars.slice(marqueeOffset).join('') +
    marqueeChars.slice(0, marqueeOffset).join('');
}, 250);

window.addEventListener('beforeunload', () => {
  window.clearInterval(marqueeTimer);
  activeRuntime?.dispose();
});

function loadRuntime(): Promise<RuntimeApi> {
  if (!runtimePromise) {
    runtimePromise = createRuntime()
      .then(runtime => {
        activeRuntime = runtime;
        return runtime;
      })
      .catch(err => {
        runtimePromise = undefined;
        throw err;
      });
  }
  return runtimePromise;
}

function revealRuntimeSurface(): void {
  stageWrap.classList.remove('intro-active');
  // Promote scene from dim → fully active. CSS handles the 1.5s ease.
  runtimeCanvas?.classList.remove('scene-dim');
  runtimeCanvas?.classList.remove('scene-pending');
  runtimeCanvas?.classList.add('scene-active');
}

async function createRuntime(): Promise<RuntimeApi> {
  const [
    { Game },
    {
      Hud,
      DEFAULT_BACKING_TRACK_VOLUME,
      DEFAULT_MUSIC_VOLUME,
      DEFAULT_STARLACE_VOLUME,
      DEFAULT_ORB_VOLUME,
      DEFAULT_VOICE_VOLUME,
    },
    { DevOverlay },
    {
      onUrlRoomChange,
      readRoomFromUrl,
      writeRoomToUrl,
    },
    { isCreatureId },
    { isInstrumentId },
    { preloadHandpose },
    { registerResetHook },
    { preloadCreatureAssets },
  ] = await Promise.all([
    import('./game/Game'),
    import('./hud/Hud'),
    import('./hud/DevOverlay'),
    import('./game/router'),
    import('./game/creatures'),
    import('./game/instruments'),
    import('./game/handTracking'),
    import('./hud/tweakDefs'),
    import('./game/rig/illustratedPuppets'),
  ]);

  const defaultAvPrefs: AvPrefs = {
    musicVolume: DEFAULT_MUSIC_VOLUME,
    starlaceVolume: DEFAULT_STARLACE_VOLUME,
    orbVolume: DEFAULT_ORB_VOLUME,
    backingTrackVolume: DEFAULT_BACKING_TRACK_VOLUME,
    voiceVolume: DEFAULT_VOICE_VOLUME,
  };
  const avPrefs: AvPrefs = { ...defaultAvPrefs };
  backingTracks.setVolume(avPrefs.backingTrackVolume);

  const canvas = document.querySelector<HTMLCanvasElement>('#scene');
  if (!canvas) {
    throw new Error('Jam Train: #scene canvas missing');
  }

  const urlRoom = readRoomFromUrl();

  const sink = (id: string): HTMLSpanElement => {
    const span = document.createElement('span');
    span.id = id;
    span.style.display = 'none';
    document.body.appendChild(span);
    return span;
  };
  const connectionSink = sink('hud-connection-sink');
  const inputSink = sink('hud-input-sink');

  const game = new Game(canvas, urlRoom, {
    connectionStatus: connectionSink,
    inputStatus: inputSink,
  });
  const stopBackingTrackAnalyzer = backingTracks.onAudioElementChange(audio => {
    game.attachBackingTrack(audio);
  });

  const initialDisplayRoom = game.getRoom();
  let started = false;
  let cameraStarting = false;

  const hud = new Hud({
    room: initialDisplayRoom,
    callbacks: {
      onRoomChange: room => {
        game.setRoom(room);
        hud.setRoom(room);
        resetShareAndMic();
      },
      onRecalibrate: () => {
        void game.startCamera();
      },
      onDisembark: () => {
        console.info('Disembark requested (no-op until multiplayer.leave is added)');
      },
      onCameraMode: mode => {
        game.setCameraMode(mode);
      },
    },
  });

  hud.setCameraMode('game');
  game.onLocalOarOrbCountChange(count => hud.setOarOrbCount(count));

  game.onAssignedRoom(room => {
    // Don't resetShareAndMic here — onAssignedRoom fires on every server
    // confirmation including the initial connect, which would silently wipe
    // the user's mic/share-video preferences set during the BeginGate.
    // resetShareAndMic stays on the explicit room-change paths below.
    writeRoomToUrl(room);
    hud.setRoom(room);
  });

  function resetShareAndMic(): void {
    if (game.getShareVideoEnabled()) {
      game.setShareVideoEnabled(false);
      hud.setShareVideoEnabled(false);
    }
    if (game.getMicEnabled()) {
      game.setMicEnabled(false);
      hud.setMicEnabled(false);
    }
  }

  game.onPlayerJoined(player => {
    const name = player.displayName?.trim() || 'A traveler';
    hud.announce(`${name} has boarded the jam train`);
  });

  game.onPartnerChange(name => {
    hud.setPartner(name);
  });

  game.onSeatChange(localSeat => {
    hud.setLocalSeat(localSeat);
  });

  hud.onLocalCreatureChange(id => {
    game.setPlayerCreature('local', id);
    void game.multiplayer.setLocalCreature(id);
    localStorage.setItem(LOCAL_CREATURE_KEY, id);
  });

  game.multiplayer.onLocalCreatureChange(id => {
    if (!isCreatureId(id)) return;
    hud.setLocalCreature(id);
    game.setPlayerCreature('local', id);
  });

  game.multiplayer.onPartnerCreatureChange(id => {
    if (!isCreatureId(id)) return;
    game.setPlayerCreature('remote', id);
  });

  hud.onLocalInstrumentChange(id => {
    game.setPlayerInstrument('local', id);
    void game.multiplayer.setLocalInstrument(id);
  });

  game.multiplayer.onLocalInstrumentChange(id => {
    if (!isInstrumentId(id)) return;
    hud.setLocalInstrument(id);
    game.setPlayerInstrument('local', id);
  });

  game.multiplayer.onPartnerInstrumentChange(id => {
    if (!isInstrumentId(id)) return;
    hud.setPartnerInstrument(id);
    game.setPlayerInstrument('remote', id);
  });

  const stopUrlRoomChange = onUrlRoomChange(room => {
    game.setRoom(room);
    hud.setRoom(room);
    resetShareAndMic();
  });

  const observe = (el: HTMLElement, push: (text: string) => void): MutationObserver => {
    const obs = new MutationObserver(() => push(el.textContent ?? ''));
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    return obs;
  };
  const observers = [
    observe(connectionSink, text => hud.setConnection(text)),
    observe(inputSink, text => hud.setInputStatus(text)),
  ];

  const dev = new DevOverlay(
    game.paneDock,
    visible => {
      if (!visible) game.setCameraMode('game');
      game.setDebugVisible(visible);
    },
    () => {
      game.setCameraMode(game.getCameraMode() === 'game' ? 'orbit' : 'game');
    },
    () => game.getAliveParticleCount(),
  );

  hud.setHandTracker(game.handTracker);
  game.onRemoteStream(stream => {
    hud.setRemoteStream(stream);
  });

  hud.onCameraToggle(() => {
    if (cameraStarting) return;
    if (game.getCameraEnabled()) {
      game.setCameraEnabled(false);
      hud.setCameraEnabled(false);
      if (game.getShareVideoEnabled()) {
        game.setShareVideoEnabled(false);
        hud.setShareVideoEnabled(false);
      }
      return;
    }

    const stream = game.handTracker.getStream();
    if (stream) {
      game.setCameraEnabled(true);
      hud.setCameraEnabled(true);
      return;
    }

    cameraStarting = true;
    void game.startCamera()
      .then(() => {
        const hasStream = !!game.handTracker.getStream();
        game.setCameraEnabled(hasStream);
        hud.setCameraEnabled(hasStream);
      })
      .catch(err => {
        console.warn('[jam-train] camera startup failed', err);
        hud.setCameraEnabled(false);
      })
      .finally(() => {
        cameraStarting = false;
      });
  });
  hud.onShareVideoToggle(() => {
    const next = !game.getShareVideoEnabled();
    game.setShareVideoEnabled(next);
    hud.setShareVideoEnabled(next);
  });
  hud.onMicToggle(() => {
    const next = !game.getMicEnabled();
    void game.setMicEnabled(next).then(() => {
      hud.setMicEnabled(game.getMicEnabled());
    });
  });
  hud.onMusicVolumeChange(value => {
    game.setMusicVolume(value);
    avPrefs.musicVolume = value;
  });
  hud.onStarlaceVolumeChange(value => {
    game.setStarlaceVolume(value);
    avPrefs.starlaceVolume = value;
  });
  hud.onOrbVolumeChange(value => {
    game.setOrbVolume(value);
    avPrefs.orbVolume = value;
  });
  hud.onBackingTrackVolumeChange(value => {
    backingTracks.setVolume(value);
    avPrefs.backingTrackVolume = value;
  });
  hud.onVoiceVolumeChange(value => {
    hud.setRemoteVolume(value);
    avPrefs.voiceVolume = value;
  });

  hud.setMidiState(game.getMidiState());
  game.onMidiStateChange(state => hud.setMidiState(state));
  hud.onMidiConnect(() => {
    void game.enableMidi().catch(err => {
      console.warn('[jam-train] MIDI enable failed', err);
    });
  });

  const handleRobotMuteKey = (e: KeyboardEvent): void => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!dev.isVisible()) return;
    const target = e.target as HTMLElement | null;
    if (target?.matches('input, textarea, [contenteditable=true]')) return;
    if (!started) return;
    const next = !game.isRobotJamMuted();
    game.setRobotJamMuted(next);
    hud.announce(next ? 'robot muted' : 'robot jamming');
  };
  window.addEventListener('keydown', handleRobotMuteKey);

  // Push-to-talk. The Mic button arms the mic (acquires permission, leaves
  // tracks disabled); holding Space transmits. Pressing Space without arming
  // does nothing — setMicTransmitting is a no-op when not armed.
  const isTextTarget = (target: EventTarget | null): boolean =>
    !!(target as HTMLElement | null)?.matches('input, textarea, [contenteditable=true]');
  const handlePushToTalkDown = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' || e.repeat) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTextTarget(e.target)) return;
    if (!started || !game.getMicEnabled()) return;
    e.preventDefault();
    game.setMicTransmitting(true);
    hud.setMicTransmitting(true);
  };
  const handlePushToTalkUp = (e: KeyboardEvent): void => {
    if (e.code !== 'Space') return;
    if (isTextTarget(e.target)) return;
    game.setMicTransmitting(false);
    hud.setMicTransmitting(false);
  };
  // Releasing focus while the key is held would otherwise leave the mic stuck
  // open; clear the transmit state on blur and visibility loss too.
  const stopPushToTalk = (): void => {
    if (started) {
      game.setMicTransmitting(false);
      hud.setMicTransmitting(false);
    }
  };
  window.addEventListener('keydown', handlePushToTalkDown);
  window.addEventListener('keyup', handlePushToTalkUp);
  window.addEventListener('blur', stopPushToTalk);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPushToTalk();
  });

  hud.setMixerValues(avPrefs.musicVolume, avPrefs.starlaceVolume, avPrefs.orbVolume, avPrefs.backingTrackVolume, avPrefs.voiceVolume);
  hud.setRemoteVolume(avPrefs.voiceVolume);

  // Pressing R in debug mode resets tweakpane params; piggyback on the same
  // registry to also restore the mixer panel to in-code defaults.
  registerResetHook('av-prefs', () => {
    avPrefs.musicVolume = defaultAvPrefs.musicVolume;
    avPrefs.starlaceVolume = defaultAvPrefs.starlaceVolume;
    avPrefs.orbVolume = defaultAvPrefs.orbVolume;
    avPrefs.backingTrackVolume = defaultAvPrefs.backingTrackVolume;
    avPrefs.voiceVolume = defaultAvPrefs.voiceVolume;
    game.setMusicVolume(avPrefs.musicVolume);
    game.setStarlaceVolume(avPrefs.starlaceVolume);
    game.setOrbVolume(avPrefs.orbVolume);
    backingTracks.setVolume(avPrefs.backingTrackVolume);
    hud.setRemoteVolume(avPrefs.voiceVolume);
    hud.setMixerValues(avPrefs.musicVolume, avPrefs.starlaceVolume, avPrefs.orbVolume, avPrefs.backingTrackVolume, avPrefs.voiceVolume);
  });

  await game.start();
  // Connect now (not in begin()) so the server's instrument/seat row
  // reconciles while introActive is still true — otherwise the visual
  // swap from random pick to server-stored value happens after the
  // instrument has already animated in.
  game.connectMultiplayer();
  await waitForInitialMultiplayerSync(game);
  const creaturePreloads: Promise<void>[] = [];
  const localCreatureId = game.multiplayer.getLocalCreature();
  const partnerCreatureId = game.multiplayer.getPartnerCreature();
  if (isCreatureId(localCreatureId)) creaturePreloads.push(preloadCreatureAssets(localCreatureId));
  if (isCreatureId(partnerCreatureId)) creaturePreloads.push(preloadCreatureAssets(partnerCreatureId));
  await Promise.all([criticalAssetsLoaded, ...creaturePreloads]);
  await game.whenNextFrameRendered();
  schedulePostSceneWarmup();

  async function begin(conductorName: string): Promise<void> {
    hud.setConductorName(conductorName);
    game.setDisplayName(conductorName);
    void preloadHandpose().catch(err => {
      console.warn('[jam-train] handpose preload failed', err);
    });

    await game.startAudio();

    hud.setCameraEnabled(false);
    hud.setMicEnabled(false);
    hud.setShareVideoEnabled(false);

    game.setMusicVolume(avPrefs.musicVolume);
    game.setStarlaceVolume(avPrefs.starlaceVolume);
    game.setOrbVolume(avPrefs.orbVolume);
    backingTracks.setVolume(avPrefs.backingTrackVolume);
    hud.setRemoteVolume(avPrefs.voiceVolume);
    hud.setMixerValues(avPrefs.musicVolume, avPrefs.starlaceVolume, avPrefs.orbVolume, avPrefs.backingTrackVolume, avPrefs.voiceVolume);

    started = true;
  }

  function dispose(): void {
    stopUrlRoomChange();
    window.removeEventListener('keydown', handleRobotMuteKey);
    window.removeEventListener('keydown', handlePushToTalkDown);
    window.removeEventListener('keyup', handlePushToTalkUp);
    window.removeEventListener('blur', stopPushToTalk);
    stopBackingTrackAnalyzer();
    for (const obs of observers) obs.disconnect();
    connectionSink.remove();
    inputSink.remove();
    hud.dispose();
    dev.dispose();
    game.dispose();
    backingTracks.dispose();
  }

  return {
    begin,
    dispose,
    setConductorName: name => hud.setConductorName(name),
    exitIntroMode: () => game.exitIntroMode(),
  };
}

function schedulePostSceneWarmup(): void {
  requestAnimationFrame(() => {
    void import('tone').catch(err => {
      console.warn('[jam-train] tone preload failed', err);
    });
  });
}

async function waitForInitialMultiplayerSync(game: { waitForInitialMultiplayerSync: () => Promise<void> }): Promise<void> {
  let timeout = 0;
  let timedOut = false;
  await Promise.race([
    game.waitForInitialMultiplayerSync(),
    new Promise<void>(resolve => {
      timeout = window.setTimeout(() => {
        timedOut = true;
        resolve();
      }, INITIAL_MULTIPLAYER_SETTLE_MS);
    }),
  ]);
  window.clearTimeout(timeout);
  if (timedOut) {
    console.warn('[jam-train] initial multiplayer sync timed out; revealing local intro scene');
  }
}
