import { handDepthConfig } from './handDepth';
import { HandFilter } from './handFilter';
import { clamp, lerpVec, vec } from './math';
import { makeSimulatedHands } from './pose';
import { fingerNames, handednesses, type FingerName, type HandPose, type Handedness, type Vec3Data } from './types';

type HandposeInput =
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap
  | HTMLImageElement
  | HTMLVideoElement
  | ImageData;

type MicroHandpose = {
  detect(source: HandposeInput): Promise<unknown[]>;
  dispose?: () => void;
  reset?: () => void;
};

type LandmarkLike = {
  x: number;
  y: number;
  z?: number;
};

export type RawDetection = {
  handedness: Handedness;
  score: number;
  landmarks: LandmarkLike[];
};

const fingerLandmarks: Record<FingerName, [number, number, number]> = {
  thumb: [2, 3, 4],
  index: [6, 7, 8],
  middle: [10, 11, 12],
  ring: [14, 15, 16],
  pinky: [18, 19, 20],
};

const keypointNames: Record<FingerName, [string, string, string]> = {
  thumb: ['thumb_mcp', 'thumb_ip', 'thumb_tip'],
  index: ['index_finger_pip', 'index_finger_dip', 'index_finger_tip'],
  middle: ['middle_finger_pip', 'middle_finger_dip', 'middle_finger_tip'],
  ring: ['ring_finger_pip', 'ring_finger_dip', 'ring_finger_tip'],
  pinky: ['pinky_finger_pip', 'pinky_finger_dip', 'pinky_finger_tip'],
};

// Baseline conversion gain for apparent-size delta → tracker-space z depth.
// Live multiplied by handDepthConfig.depthGain. The "neutral" palm size is
// also user-tunable via handDepthConfig.referencePalmSize.
const DEPTH_FROM_SIZE = 4.5;

const MAX_TRACKED_HANDS = 2;
// micro-handpose 0.3.0 only re-runs palm detection when every tracked ROI is
// lost. If we sit at fewer than MAX_TRACKED_HANDS for this many cycles, force
// a reset so a hand that has re-entered the frame can actually be picked up.
const LOCK_IN_DETECTIONS = 8;
const RESET_COOLDOWN_S = 1;

export class HandTracker {
  private video?: HTMLVideoElement;
  private detector?: MicroHandpose;
  private detectInputCanvas?: HTMLCanvasElement;
  private detectInputCtx?: CanvasRenderingContext2D;
  private detectRafHandle = 0;
  private detectLoopRunning = false;
  private latestUpdateTime = 0;
  private cameraHands?: Record<Handedness, HandPose>;
  private rawDetections: RawDetection[] = [];
  private pointer = { x: 0, y: 0 };
  private mode: 'simulated' | 'camera' | 'error' = 'simulated';
  private status = 'hands: simulated';
  private partialDetectionRun = 0;
  private lastResetAt = -Infinity;
  private prevDetectedHandedness = new Set<Handedness>();
  readonly filter = new HandFilter();

  constructor(private statusTarget?: HTMLElement) {
    window.addEventListener('pointermove', event => {
      this.pointer.x = (event.clientX / Math.max(window.innerWidth, 1)) * 2 - 1;
      this.pointer.y = -((event.clientY / Math.max(window.innerHeight, 1)) * 2 - 1);
    });
    this.publishStatus();
  }

  async startCamera(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.mode = 'error';
      this.status = 'hands: no camera';
      this.publishStatus();
      return;
    }

    const baseConstraints: MediaStreamConstraints = {
      video: { width: { ideal: 960 }, height: { ideal: 540 }, facingMode: 'user' },
      audio: true,
    };

    let stream: MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia(baseConstraints);
    } catch (err) {
      console.warn(
        '[webrtc] mic+camera request failed; retrying video-only',
        (err as Error)?.name,
        (err as Error)?.message
      );
      try {
        stream = await navigator.mediaDevices.getUserMedia({ ...baseConstraints, audio: false });
        console.warn('[webrtc] mic unavailable; webrtc will be video-only');
      } catch (err2) {
        console.warn('[webrtc] camera unavailable; webrtc disabled', err2);
        this.mode = 'error';
        this.status = 'hands: simulated';
        this.publishStatus();
        return;
      }
    }

    try {
      // Tracks start disabled — the user toggles them in via the panel icons.
      // Permission is acquired here so we don't have to re-prompt on toggle.
      for (const track of stream.getTracks()) {
        track.enabled = false;
      }

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      video.srcObject = stream;
      video.style.display = 'none';
      document.body.appendChild(video);
      await video.play();

      const { createHandpose } = await import('@svenflow/micro-handpose');
      this.detector = await createHandpose({ maxHands: 2, scoreThreshold: 0.45 });
      this.video = video;
      this.mode = 'camera';
      this.status = 'hands: camera';
      this.publishStatus();
      this.startDetectLoop();
    } catch (error) {
      console.warn('Hand tracking fell back to simulation', error);
      this.mode = 'error';
      this.status = 'hands: simulated';
      this.publishStatus();
    }
  }

  update(time: number): Record<Handedness, HandPose> {
    this.latestUpdateTime = time;

    const simulated = makeSimulatedHands(time, this.pointer.x, this.pointer.y);
    if (!this.cameraHands) return simulated;

    const hands = {} as Record<Handedness, HandPose>;
    for (const handedness of handednesses) {
      hands[handedness] = this.cameraHands[handedness] ?? simulated[handedness];
    }
    return hands;
  }

  // Mirrors the official micro-handpose demo: chain detect → rAF → detect with
  // no throttle, so the overlay tracks the live video as tightly as the model
  // allows. The intermediate canvas avoids per-frame createImageBitmap cost
  // and works around an iOS Safari WebGPU bug noted in the demo source.
  private startDetectLoop(): void {
    if (this.detectLoopRunning || !this.video || !this.detector) return;
    this.detectLoopRunning = true;

    const inputCanvas = document.createElement('canvas');
    const inputCtx = inputCanvas.getContext('2d');
    if (inputCtx) {
      this.detectInputCanvas = inputCanvas;
      this.detectInputCtx = inputCtx;
    }

    const tick = (): void => {
      if (!this.detectLoopRunning || !this.video || !this.detector) return;

      const w = this.video.videoWidth;
      const h = this.video.videoHeight;
      let source: HandposeInput = this.video;
      if (this.detectInputCanvas && this.detectInputCtx && w && h) {
        if (this.detectInputCanvas.width !== w || this.detectInputCanvas.height !== h) {
          this.detectInputCanvas.width = w;
          this.detectInputCanvas.height = h;
        }
        this.detectInputCtx.drawImage(this.video, 0, 0);
        source = this.detectInputCanvas;
      }

      this.detector
        .detect(source)
        .then(results => {
          const time = this.latestUpdateTime;
          this.maybeResetForLockIn(results.length, time);
          this.cameraHands = this.mapDetections(results, time);
          this.status = this.cameraHands ? 'hands: camera' : 'hands: searching';
          this.publishStatus();
        })
        .catch(error => {
          console.warn('Hand detection failed', error);
          this.status = 'hands: simulated';
          this.publishStatus();
        })
        .finally(() => {
          if (this.detectLoopRunning) {
            this.detectRafHandle = requestAnimationFrame(tick);
          }
        });
    };
    this.detectRafHandle = requestAnimationFrame(tick);
  }

  getVideo(): HTMLVideoElement | undefined {
    return this.video;
  }

  getStream(): MediaStream | undefined {
    const src = this.video?.srcObject;
    return src instanceof MediaStream ? src : undefined;
  }

  setVideoEnabled(enabled: boolean): void {
    const stream = this.getStream();
    if (!stream) return;
    for (const track of stream.getVideoTracks()) {
      track.enabled = enabled;
    }
    if (!enabled) {
      // Drop stale detections so the rig stops freezing on the last camera
      // pose the moment the camera goes dark.
      this.cameraHands = undefined;
      this.rawDetections = [];
    }
  }

  setAudioEnabled(enabled: boolean): void {
    const stream = this.getStream();
    if (!stream) return;
    for (const track of stream.getAudioTracks()) {
      track.enabled = enabled;
    }
  }

  getVideoEnabled(): boolean {
    const stream = this.getStream();
    if (!stream) return false;
    return stream.getVideoTracks().some(t => t.enabled);
  }

  getAudioEnabled(): boolean {
    const stream = this.getStream();
    if (!stream) return false;
    return stream.getAudioTracks().some(t => t.enabled);
  }

  getDetections(): readonly RawDetection[] {
    return this.rawDetections;
  }

  dispose(): void {
    this.detectLoopRunning = false;
    cancelAnimationFrame(this.detectRafHandle);
    this.detector?.dispose?.();
    if (this.video?.srcObject instanceof MediaStream) {
      for (const track of this.video.srcObject.getTracks()) track.stop();
    }
    this.video?.remove();
    this.filter.dispose();
  }

  attachPane(paneDock: HTMLElement): void {
    this.filter.attachPane(paneDock);
  }

  private mapDetections(results: unknown[], time: number): Record<Handedness, HandPose> | undefined {
    this.rawDetections = [];
    if (results.length === 0) return undefined;

    type RawHand = {
      handedness?: Handedness | string;
      score?: number;
      landmarks?: LandmarkLike[];
      keypoints?: Record<string, LandmarkLike>;
    };

    const candidates = results
      .slice(0, 2)
      .map(raw => raw as RawHand)
      .filter(hand => hand.landmarks?.length || hand.keypoints?.wrist);

    const wristX = (hand: RawHand): number =>
      hand.keypoints?.wrist?.x ?? hand.landmarks?.[0]?.x ?? 0.5;

    // Selfie/mirror convention: leftmost wrist (smallest image x) = user's right.
    // We override the model label here because micro-handpose frequently reports
    // both detections with the same handedness, which collapses one hand.
    const assignments: { hand: RawHand; handedness: Handedness }[] = [];
    if (candidates.length >= 2) {
      const sorted = [...candidates].sort((a, b) => wristX(a) - wristX(b));
      assignments.push({ hand: sorted[0], handedness: 'right' });
      assignments.push({ hand: sorted[1], handedness: 'left' });
    } else if (candidates.length === 1) {
      const hand = candidates[0];
      const handedness = hand.handedness === 'left' || hand.handedness === 'right'
        ? hand.handedness
        : this.inferHandedness(hand);
      assignments.push({ hand, handedness });
    }

    const presentNow = new Set<Handedness>(assignments.map(a => a.handedness));
    for (const handedness of handednesses) {
      if (presentNow.has(handedness) && !this.prevDetectedHandedness.has(handedness)) {
        this.filter.resetHand(handedness);
      }
    }
    this.prevDetectedHandedness = presentNow;

    const mapped = {} as Partial<Record<Handedness, HandPose>>;
    for (const { hand, handedness } of assignments) {
      const filteredHand: RawHand = {
        ...hand,
        landmarks: hand.landmarks ? this.filter.applyToLandmarks(handedness, hand.landmarks) : undefined,
        keypoints: hand.keypoints ? this.filter.applyToKeypoints(handedness, hand.keypoints) : undefined,
      };
      if (filteredHand.landmarks?.length) {
        this.rawDetections.push({
          handedness,
          score: clamp(filteredHand.score ?? 0.7, 0, 1),
          landmarks: filteredHand.landmarks,
        });
      }
      mapped[handedness] = this.handFromLandmarks(filteredHand, handedness, time);
    }

    if (!mapped.left && !mapped.right) return undefined;

    const completed = makeSimulatedHands(time, this.pointer.x, this.pointer.y);
    for (const handedness of handednesses) {
      const detected = mapped[handedness];
      if (!detected) continue;
      const previous = this.cameraHands?.[handedness] ?? detected;
      completed[handedness] = this.smoothHand(previous, detected, 0.42);
    }

    return completed;
  }

  private handFromLandmarks(
    hand: { score?: number; landmarks?: LandmarkLike[]; keypoints?: Record<string, LandmarkLike> },
    handedness: Handedness,
    time: number
  ): HandPose {
    const fallback = makeSimulatedHands(time, this.pointer.x, this.pointer.y)[handedness];

    const readImg = (key: string, index: number): LandmarkLike | undefined =>
      hand.keypoints?.[key] ?? hand.landmarks?.[index];

    const wristImg = readImg('wrist', 0);
    const middleImg = readImg('middle_finger_mcp', 9);
    if (!wristImg || !middleImg) return fallback;

    // Apparent palm size in image space — proxy for hand-to-camera distance.
    // We rescale all landmark offsets by REFERENCE_PALM_SIZE / palmSize so the
    // rendered hand stays a constant size, and route the size delta into z so
    // the hand translates in depth instead of stretching in x/y.
    const palmDx = middleImg.x - wristImg.x;
    const palmDy = middleImg.y - wristImg.y;
    const palmSize = Math.max(Math.hypot(palmDx, palmDy), 1e-4);
    const referencePalmSize = handDepthConfig.referencePalmSize;
    const sizeScale = clamp(referencePalmSize / palmSize, 0.5, 2.0);
    const depth = clamp(
      (palmSize - referencePalmSize) * DEPTH_FROM_SIZE * handDepthConfig.depthGain,
      -0.45,
      0.45
    );

    const wristZ = wristImg.z ?? 0;
    const transform = (img: LandmarkLike): Vec3Data => {
      const offX = (img.x - wristImg.x) * sizeScale;
      const offY = (img.y - wristImg.y) * sizeScale;
      const offZ = (img.z ?? 0) - wristZ;
      return vec(
        (0.5 - wristImg.x - offX) * 1.8,
        (1 - wristImg.y - offY) * 1.35,
        depth + clamp(-offZ * 4.5, -0.45, 0.45)
      );
    };

    const wrist = transform(wristImg);
    const palmRaw = transform(middleImg);
    const palm = vec(
      (wrist.x + palmRaw.x) * 0.5,
      (wrist.y + palmRaw.y) * 0.5,
      (wrist.z + palmRaw.z) * 0.5
    );

    const fingers = { ...fallback.fingers };
    for (const name of fingerNames) {
      const [baseIndex, midIndex, tipIndex] = fingerLandmarks[name];
      const [baseKey, midKey, tipKey] = keypointNames[name];
      const baseImg = readImg(baseKey, baseIndex);
      const midImg = readImg(midKey, midIndex);
      const tipImg = readImg(tipKey, tipIndex);
      const base = baseImg ? transform(baseImg) : fallback.fingers[name].base;
      const mid = midImg ? transform(midImg) : fallback.fingers[name].mid;
      const tip = tipImg ? transform(tipImg) : fallback.fingers[name].tip;
      const openLength = Math.max(Math.abs(tip.y - base.y), 0.001);
      const curledDepth = Math.abs(tip.z - mid.z) + Math.max(0, mid.y - tip.y);
      fingers[name] = {
        name,
        base,
        mid,
        tip,
        curl: clamp(curledDepth / (openLength + 0.18), 0, 1),
      };
    }

    return {
      handedness,
      wrist,
      palm,
      fingers,
      confidence: clamp(hand.score ?? 0.7, 0, 1),
    };
  }

  private maybeResetForLockIn(detectionCount: number, time: number): void {
    if (detectionCount > 0 && detectionCount < MAX_TRACKED_HANDS) {
      this.partialDetectionRun += 1;
    } else {
      this.partialDetectionRun = 0;
    }
    if (
      this.partialDetectionRun >= LOCK_IN_DETECTIONS &&
      time - this.lastResetAt >= RESET_COOLDOWN_S
    ) {
      this.detector?.reset?.();
      this.partialDetectionRun = 0;
      this.lastResetAt = time;
    }
  }

  private inferHandedness(hand: { landmarks?: LandmarkLike[] }): Handedness {
    const wrist = hand.landmarks?.[0];
    const index = hand.landmarks?.[8];
    if (!wrist || !index) return 'right';
    return index.x < wrist.x ? 'right' : 'left';
  }

  private smoothHand(previous: HandPose, next: HandPose, amount: number): HandPose {
    const fingers = {} as HandPose['fingers'];
    for (const name of fingerNames) {
      fingers[name] = {
        name,
        base: lerpVec(previous.fingers[name].base, next.fingers[name].base, amount),
        mid: lerpVec(previous.fingers[name].mid, next.fingers[name].mid, amount),
        tip: lerpVec(previous.fingers[name].tip, next.fingers[name].tip, amount),
        curl: previous.fingers[name].curl + (next.fingers[name].curl - previous.fingers[name].curl) * amount,
      };
    }

    return {
      handedness: next.handedness,
      wrist: lerpVec(previous.wrist, next.wrist, amount),
      palm: lerpVec(previous.palm, next.palm, amount),
      fingers,
      confidence: next.confidence,
    };
  }

  private publishStatus(): void {
    if (this.statusTarget) this.statusTarget.textContent = this.status;
  }
}
