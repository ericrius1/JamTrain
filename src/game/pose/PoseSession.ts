import type { PlayerPose } from '../types';
import type { PoseTransport } from './PoseTransport';

export type PoseSessionConfig = {
  /** Source of the local player's identity. Read fresh on every send so that
   *  the SpacetimeDB-issued identity, which arrives async after construction,
   *  replaces the boot-time placeholder before any pose is stamped. */
  getLocalId: () => string;
  /** Source of the current room id (read fresh on every send). */
  getRoomId: () => string;
  /** Source of the partner's seat index (used to stamp inbound poses). */
  getPartnerSeatIndex: () => number;
  /** Minimum interval between outbound sends, in seconds. */
  sendIntervalSec?: number;
};

const DEFAULT_INTERVAL_SEC = 0.033; // ~30 Hz

/**
 * Owns the local + remote pose state. Throttles outbound, fans across all
 * transports, merges inbound from any transport (last-write-wins). Ignores
 * its own id on inbound so a transport that echoes (e.g. BroadcastChannel
 * loopback in some browsers) never feeds us our own pose.
 */
export class PoseSession {
  private remotePose?: PlayerPose;
  private localPose?: PlayerPose;
  private lastSendAt = 0;
  private readonly intervalSec: number;

  constructor(
    private readonly transports: PoseTransport[],
    private readonly config: PoseSessionConfig,
  ) {
    this.intervalSec = config.sendIntervalSec ?? DEFAULT_INTERVAL_SEC;
    for (const t of transports) t.onPose(pose => this.acceptInbound(pose));
  }

  /** Per-frame call from the game loop. Returns true if a send actually happened. */
  sendLocalPose(pose: PlayerPose, time: number): boolean {
    if (time - this.lastSendAt < this.intervalSec) return false;
    this.lastSendAt = time;
    const stamped: PlayerPose = { ...pose, id: this.config.getLocalId(), roomId: this.config.getRoomId() };
    this.localPose = stamped;
    for (const t of this.transports) t.send(stamped);
    return true;
  }

  getRemotePose(): PlayerPose | undefined {
    return this.remotePose;
  }

  getLocalPose(): PlayerPose | undefined {
    return this.localPose;
  }

  /** Drop the cached remote pose — used when partner identity changes. */
  clearRemotePose(): void {
    this.remotePose = undefined;
  }

  dispose(): void {
    for (const t of this.transports) t.dispose();
  }

  private acceptInbound(pose: PlayerPose): void {
    if (pose.id === this.config.getLocalId()) return;
    this.remotePose = {
      ...pose,
      roomId: this.config.getRoomId(),
      seatIndex: this.config.getPartnerSeatIndex(),
      updatedAt: Date.now(),
    };
  }
}
