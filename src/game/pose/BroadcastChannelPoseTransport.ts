import { parsePose, serializePose } from '../pose';
import type { PlayerPose } from '../types';
import type { PoseListener, PoseTransport } from './PoseTransport';

const CHANNEL_PREFIX = 'jam-train-';

export class BroadcastChannelPoseTransport implements PoseTransport {
  private listeners = new Set<PoseListener>();
  private channel?: BroadcastChannel;
  private currentRoomId: string;

  constructor(initialRoomId: string) {
    this.currentRoomId = initialRoomId;
    this.openChannel(initialRoomId);
  }

  /** Re-key the channel after a room change (so we don't leak across rooms). */
  setRoomId(roomId: string): void {
    if (roomId === this.currentRoomId) return;
    this.currentRoomId = roomId;
    this.openChannel(roomId);
  }

  send(pose: PlayerPose): void {
    if (!this.channel) return;
    this.channel.postMessage({
      type: 'pose',
      roomId: this.currentRoomId,
      poseJson: serializePose(pose),
      sentAt: Date.now(),
    });
  }

  onPose(listener: PoseListener): void {
    this.listeners.add(listener);
  }

  dispose(): void {
    this.channel?.close();
    this.channel = undefined;
    this.listeners.clear();
  }

  private openChannel(roomId: string): void {
    this.channel?.close();
    if (!('BroadcastChannel' in window)) return;
    this.channel = new BroadcastChannel(`${CHANNEL_PREFIX}${roomId}`);
    this.channel.onmessage = event => {
      const data = event.data as { type?: string; roomId?: string; poseJson?: string };
      if (data.type !== 'pose' || data.roomId !== this.currentRoomId || !data.poseJson) return;
      const pose = parsePose(data.poseJson);
      if (!pose) return;
      for (const l of this.listeners) l(pose);
    };
  }
}
