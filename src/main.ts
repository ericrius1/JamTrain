import './style.css';
import { BeginGate } from './hud/components/BeginGate';
import { registerHandposeCacheWorker } from './game/handposeCache';

window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});

const LOCAL_CREATURE_KEY = 'jam-train.local-creature';
const LOCAL_INSTRUMENT_KEY = 'jam-train.local-instrument';
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
};

const stageWrapEl = document.getElementById('stage-wrap');
if (!stageWrapEl) {
  throw new Error('Jam Train: #stage-wrap mount missing');
}
const stageWrap = stageWrapEl;

const runtimeCanvas = document.querySelector<HTMLCanvasElement>('#scene');
runtimeCanvas?.style.setProperty('visibility', 'hidden');
stageWrap.classList.add('intro-active');

let activeRuntime: RuntimeApi | undefined;
let runtimePromise: Promise<RuntimeApi> | undefined;

const beginGate = new BeginGate({
  onBegin: async conductorName => {
    const runtime = await loadRuntime();
    runtime.setConductorName(conductorName);
    await runtime.begin(conductorName);
    revealRuntimeSurface();
  },
});
stageWrap.appendChild(beginGate.el);
void registerHandposeCacheWorker();

// Let the intro hit the screen first, then warm the full Three/WebGPU runtime.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    void loadRuntime().catch(err => {
      console.warn('[jam-train] runtime preload failed', err);
    });
  });
});

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
  runtimeCanvas?.style.removeProperty('visibility');
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
  ] = await Promise.all([
    import('./game/Game'),
    import('./hud/Hud'),
    import('./hud/DevOverlay'),
    import('./game/router'),
    import('./game/creatures'),
    import('./game/instruments'),
    import('./game/handTracking'),
  ]);

  const avPrefs = loadPrefs({
    backingVolume: DEFAULT_BACKING_VOLUME,
    musicVolume: DEFAULT_MUSIC_VOLUME,
    voiceVolume: DEFAULT_VOICE_VOLUME,
  });

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

  game.onAssignedRoom(room => {
    writeRoomToUrl(room);
    hud.setRoom(room);
    resetShareAndMic();
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

  const storedCreature = localStorage.getItem(LOCAL_CREATURE_KEY);
  if (storedCreature !== null && isCreatureId(storedCreature)) {
    game.setPlayerCreature('local', storedCreature);
    void game.multiplayer.setLocalCreature(storedCreature);
  }

  hud.onLocalInstrumentChange(id => {
    game.setPlayerInstrument('local', id);
    void game.multiplayer.setLocalInstrument(id);
    localStorage.setItem(LOCAL_INSTRUMENT_KEY, id);
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

  const storedInstrument = localStorage.getItem(LOCAL_INSTRUMENT_KEY);
  if (storedInstrument !== null && isInstrumentId(storedInstrument)) {
    hud.setLocalInstrument(storedInstrument);
    game.setPlayerInstrument('local', storedInstrument);
    void game.multiplayer.setLocalInstrument(storedInstrument);
  }

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
    game.setMicEnabled(next);
    hud.setMicEnabled(next);
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

  await game.start();
  schedulePostSceneWarmup();

  async function begin(conductorName: string): Promise<void> {
    hud.setConductorName(conductorName);
    game.setDisplayName(conductorName);
    void preloadHandpose().catch(err => {
      console.warn('[jam-train] handpose preload failed', err);
    });

    await game.startAudio();
    game.connectMultiplayer();

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
  };
}

function schedulePostSceneWarmup(): void {
  requestAnimationFrame(() => {
    void import('tone').catch(err => {
      console.warn('[jam-train] tone preload failed', err);
    });
  });
}
