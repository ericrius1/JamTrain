import { parsePose, serializePose } from '../pose';
import type { PlayerPose } from '../types';
import type { WebRTCClient } from '../webrtc';
import type { PoseListener, PoseTransport } from './PoseTransport';

export class WebRtcPoseTransport implements PoseTransport {
  private listeners = new Set<PoseListener>();
  private wired = false;

  constructor(private webrtc: WebRTCClient) {
    this.wired = true;
    this.webrtc.onRemotePose(json => {
      const pose = parsePose(json);
      if (!pose) return;
      for (const l of this.listeners) l(pose);
    });
  }

  send(pose: PlayerPose): void {
    if (!this.wired) return;
    this.webrtc.sendPose(serializePose(pose));
  }

  onPose(listener: PoseListener): void {
    this.listeners.add(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.wired = false;
  }
}
