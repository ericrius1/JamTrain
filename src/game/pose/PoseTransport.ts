import type { PlayerPose } from '../types';

export type PoseListener = (pose: PlayerPose) => void;

/**
 * One way to ship pose data between two clients. Implementations wrap any
 * underlying transport (WebRTC data channel, BroadcastChannel, etc.). They
 * are responsible only for moving `PlayerPose` objects across — not for
 * throttling, identity filtering, or state ownership.
 */
export interface PoseTransport {
  /** Best-effort send. Drops silently if the underlying channel is not ready. */
  send(pose: PlayerPose): void;

  /** Subscribe to inbound poses. Listeners run synchronously. */
  onPose(listener: PoseListener): void;

  /** Tear down underlying resources. Idempotent. */
  dispose(): void;
}
