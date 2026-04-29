import './style.css';
import { BeginGate } from './hud/components/BeginGate';
import { registerHandposeCacheWorker } from './game/handposeCache';

window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});

const LOCAL_CREATURE_KEY = 'jam-train.local-creature';
const PREFS_KEY = 'jam-train-av-prefs';

type AvPrefs = {
  backingVolume: number;
  musicVolume: number;
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
let sceneRevealed = runtimeCanvas?.classList.contains('scene-dim') ?? false;

// Pre-warm the browser cache for the assets needed to draw the very first
// frame of the world (train shell + first scenery panel + stored puppets).
// Everything else can lazy-load behind it. We don't await the result before
// constructing the runtime — we just want the bytes in flight by the time
// THREE.TextureLoader asks for them.
const criticalAssetsLoaded = preloadCriticalAssets();

const beginGate = new BeginGate({
  onBegin: async conductorName => {
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
  },
});
stageWrap.appendChild(beginGate.el);
void registerHandposeCacheWorker();

// Let the intro hit the screen first, then warm the full Three/WebGPU
// runtime. The canvas starts in its dimmed class from markup; revealDimmedScene
// remains as a fallback if that class is ever absent.
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

function preloadCriticalAssets(): Promise<void> {
  const storedCreature = localStorage.getItem(LOCAL_CREATURE_KEY) ?? 'lion';
  const partnerCreature = 'robot';
  const puppetParts = ['body.webp', 'upper-arm.webp', 'forearm.webp'];
  const localPuppet = `${storedCreature}/${storedCreature === 'robot' ? 'hand-cupped.webp' : storedCreature === 'lion' ? 'paw-cupped.webp' : 'hand-cupped.webp'}`;
  const partnerHand = `${partnerCreature}/hand-cupped.webp`;

  const urls: string[] = [
    '/cabin/illustrated-cabin-plate-v2-color.webp',
    '/cabin/illustrated-cabin-plate-v2-alpha.webp',
    '/scenery/far-terrain-chunk-01-alpine-lake.webp',
    '/scenery/far-terrain-chunk-02-fog-forest.webp',
    `/puppets/${localPuppet}`,
    `/puppets/${partnerHand}`,
    ...puppetParts.flatMap(part => [
      `/puppets/${storedCreature}/${part}`,
      `/puppets/${partnerCreature}/${part}`,
    ]),
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
  sceneRevealed = true;
  // Two RAFs so the initial opacity:0 is committed before we toggle the
  // class — otherwise the transition can be skipped on first paint.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      runtimeCanvas?.classList.add('scene-dim');
    });
  });
}

const marquee = '🚂 Jam Train ';
let marqueeOffset = 0;
const marqueeTimer = window.setInterval(() => {
  marqueeOffset = (marqueeOffset + 1) % marquee.length;
  document.title = marquee.slice(marqueeOffset) + marquee.slice(0, marqueeOffset);
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
  runtimeCanvas?.classList.add('scene-active');
}

const clampUnit = (n: unknown, fallback: number): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.max(0, Math.min(1, v));
};

function loadPrefs(defaults: AvPrefs): AvPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<AvPrefs>;
    return {
      backingVolume: clampUnit(parsed.backingVolume, defaults.backingVolume),
      musicVolume: clampUnit(parsed.musicVolume, defaults.musicVolume),
      voiceVolume: clampUnit(parsed.voiceVolume, defaults.voiceVolume),
    };
  } catch {
    return defaults;
  }
}

function savePrefs(prefs: AvPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* storage may be disabled - non-fatal */
  }
}

async function createRuntime(): Promise<RuntimeApi> {
  const [
    { Game },
    {
      Hud,
      DEFAULT_BACKING_VOLUME,
      DEFAULT_MUSIC_VOLUME,
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
  ] = await Promise.all([
    import('./game/Game'),
    import('./hud/Hud'),
    import('./hud/DevOverlay'),
    import('./game/router'),
    import('./game/creatures'),
    import('./game/instruments'),
    import('./game/handTracking'),
    import('./hud/tweakDefs'),
  ]);

  const defaultAvPrefs: AvPrefs = {
    backingVolume: DEFAULT_BACKING_VOLUME,
    musicVolume: DEFAULT_MUSIC_VOLUME,
    voiceVolume: DEFAULT_VOICE_VOLUME,
  };
  const avPrefs = loadPrefs(defaultAvPrefs);

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
  const musicSink = sink('hud-music-sink');

  const game = new Game(canvas, urlRoom, {
    connectionStatus: connectionSink,
    inputStatus: inputSink,
    musicStatus: musicSink,
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
  game.onLocalDrumOrbCountChange(count => hud.setDrumOrbCount(count));

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
    observe(musicSink, text => hud.setMusicStatus(text)),
  ];

  const dev = new DevOverlay(
    game.paneDock,
    visible => {
      if (!visible) game.setCameraMode('game');
    },
    () => {
      game.setCameraMode(game.getCameraMode() === 'game' ? 'orbit' : 'game');
    },
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
  hud.onBackingVolumeChange(value => {
    game.setBackingVolume(value);
    avPrefs.backingVolume = value;
    savePrefs(avPrefs);
  });
  hud.onMusicVolumeChange(value => {
    game.setMusicVolume(value);
    avPrefs.musicVolume = value;
    savePrefs(avPrefs);
  });
  hud.onVoiceVolumeChange(value => {
    hud.setRemoteVolume(value);
    avPrefs.voiceVolume = value;
    savePrefs(avPrefs);
  });

  const handleRobotMuteKey = (e: KeyboardEvent): void => {
    if (e.key !== 'm' && e.key !== 'M') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target?.matches('input, textarea, [contenteditable=true]')) return;
    if (!started) return;
    const next = !game.isRobotJamMuted();
    game.setRobotJamMuted(next);
    hud.announce(next ? 'robot muted' : 'robot jamming');
  };
  window.addEventListener('keydown', handleRobotMuteKey);

  hud.setMixerValues(avPrefs.backingVolume, avPrefs.musicVolume, avPrefs.voiceVolume);
  hud.setRemoteVolume(avPrefs.voiceVolume);

  // Pressing R in debug mode resets tweakpane params; piggyback on the same
  // registry to also restore the mixer panel + persisted A/V prefs.
  registerResetHook('av-prefs', () => {
    avPrefs.backingVolume = defaultAvPrefs.backingVolume;
    avPrefs.musicVolume = defaultAvPrefs.musicVolume;
    avPrefs.voiceVolume = defaultAvPrefs.voiceVolume;
    try { localStorage.removeItem(PREFS_KEY); } catch { /* noop */ }
    game.setBackingVolume(avPrefs.backingVolume);
    game.setMusicVolume(avPrefs.musicVolume);
    hud.setRemoteVolume(avPrefs.voiceVolume);
    hud.setMixerValues(avPrefs.backingVolume, avPrefs.musicVolume, avPrefs.voiceVolume);
  });

  await game.start();
  schedulePostSceneWarmup();

  async function begin(conductorName: string): Promise<void> {
    hud.setConductorName(conductorName);
    game.setDisplayName(conductorName);
    void preloadHandpose().catch(err => {
      console.warn('[jam-train] handpose preload failed', err);
    });

    game.connectMultiplayer();
    await game.startAudio();

    hud.setCameraEnabled(false);
    hud.setMicEnabled(false);
    hud.setShareVideoEnabled(false);

    game.setBackingVolume(avPrefs.backingVolume);
    game.setMusicVolume(avPrefs.musicVolume);
    hud.setRemoteVolume(avPrefs.voiceVolume);
    hud.setMixerValues(avPrefs.backingVolume, avPrefs.musicVolume, avPrefs.voiceVolume);

    started = true;
  }

  function dispose(): void {
    stopUrlRoomChange();
    window.removeEventListener('keydown', handleRobotMuteKey);
    for (const obs of observers) obs.disconnect();
    connectionSink.remove();
    inputSink.remove();
    musicSink.remove();
    hud.dispose();
    dev.dispose();
    game.dispose();
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
