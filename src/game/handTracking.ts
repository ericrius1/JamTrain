import { clamp, lerpVec, vec } from './math';
import { makeSimulatedHands } from './pose';
import { fingerNames, handednesses, type FingerName, type HandPose, type Handedness, type Vec3Data } from './types';

type MicroHandpose = {
  detect(source: HTMLVideoElement): Promise<unknown[]>;
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

export class HandTracker {
  private video?: HTMLVideoElement;
  private detector?: MicroHandpose;
  private detecting = false;
  private lastDetectAt = 0;
  private cameraHands?: Record<Handedness, HandPose>;
  private rawDetections: RawDetection[] = [];
  private pointer = { x: 0, y: 0 };
  private mode: 'simulated' | 'camera' | 'error' = 'simulated';
  private status = 'hands: simulated';

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

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960 },
          height: { ideal: 540 },
          facingMode: 'user',
        },
        audio: false,
      });

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
    } catch (error) {
      console.warn('Hand tracking fell back to simulation', error);
      this.mode = 'error';
      this.status = 'hands: simulated';
      this.publishStatus();
    }
  }

  update(time: number): Record<Handedness, HandPose> {
    if (this.mode === 'camera' && this.video && this.detector && time - this.lastDetectAt > 0.045 && !this.detecting) {
      this.lastDetectAt = time;
      this.detecting = true;
      void this.detector
        .detect(this.video)
        .then(results => {
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
          this.detecting = false;
        });
    }

    const simulated = makeSimulatedHands(time, this.pointer.x, this.pointer.y);
    if (!this.cameraHands) return simulated;

    const hands = {} as Record<Handedness, HandPose>;
    for (const handedness of handednesses) {
      hands[handedness] = this.cameraHands[handedness] ?? simulated[handedness];
    }
    return hands;
  }

  getVideo(): HTMLVideoElement | undefined {
    return this.video;
  }

  getDetections(): readonly RawDetection[] {
    return this.rawDetections;
  }

  dispose(): void {
    this.detector?.dispose?.();
    if (this.video?.srcObject instanceof MediaStream) {
      for (const track of this.video.srcObject.getTracks()) track.stop();
    }
    this.video?.remove();
  }

  private mapDetections(results: unknown[], time: number): Record<Handedness, HandPose> | undefined {
    this.rawDetections = [];
    if (results.length === 0) return undefined;

    const mapped = {} as Partial<Record<Handedness, HandPose>>;
    for (const raw of results.slice(0, 2)) {
      const hand = raw as {
        handedness?: Handedness | string;
        score?: number;
        landmarks?: LandmarkLike[];
        keypoints?: Record<string, LandmarkLike>;
      };
      const handedness = hand.handedness === 'left' || hand.handedness === 'right' ? hand.handedness : this.inferHandedness(hand);
      if (hand.landmarks?.length) {
        this.rawDetections.push({
          handedness,
          score: clamp(hand.score ?? 0.7, 0, 1),
          landmarks: hand.landmarks,
        });
      }
      mapped[handedness] = this.handFromLandmarks(hand, handedness, time);
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
    const wrist = this.readPoint(hand, 'wrist', 0) ?? fallback.wrist;
    const palmRaw = this.readPoint(hand, 'middle_finger_mcp', 9) ?? fallback.palm;
    const palm = {
      x: (wrist.x + palmRaw.x) * 0.5,
      y: (wrist.y + palmRaw.y) * 0.5,
      z: (wrist.z + palmRaw.z) * 0.5,
    };

    const fingers = { ...fallback.fingers };
    for (const name of fingerNames) {
      const [baseIndex, midIndex, tipIndex] = fingerLandmarks[name];
      const [baseKey, midKey, tipKey] = keypointNames[name];
      const base = this.readPoint(hand, baseKey, baseIndex) ?? fallback.fingers[name].base;
      const mid = this.readPoint(hand, midKey, midIndex) ?? fallback.fingers[name].mid;
      const tip = this.readPoint(hand, tipKey, tipIndex) ?? fallback.fingers[name].tip;
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

  private readPoint(
    hand: { landmarks?: LandmarkLike[]; keypoints?: Record<string, LandmarkLike> },
    key: string,
    index: number
  ): Vec3Data | undefined {
    const source = hand.keypoints?.[key] ?? hand.landmarks?.[index];
    if (!source) return undefined;

    return vec(
      (0.5 - source.x) * 1.8,
      (1 - source.y) * 1.35,
      clamp(-(source.z ?? 0) * 2.4, -0.35, 0.5)
    );
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
