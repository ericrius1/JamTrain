import type { MultiplayerClient } from './multiplayer';

type RemoteStreamListener = (stream: MediaStream | null) => void;
type StreamProvider = () => MediaStream | undefined;
type RemotePoseListener = (poseJson: string) => void;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

const POSE_CHANNEL_LABEL = 'pose';

export class WebRTCClient {
  private pc?: RTCPeerConnection;
  private remoteStream?: MediaStream;
  private remoteListeners = new Set<RemoteStreamListener>();
  private partnerIdentity: string | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private makingOffer = false;
  private queuedNegotiation = false;
  private disposed = false;
  // Cloned video track that we hand to the peer connection. Kept independent
  // of HandTracker's original so the user can have local tracking on without
  // sharing video with the partner (and vice versa).
  private videoSenderTrack?: MediaStreamTrack;
  private audioSenderTrack?: MediaStreamTrack;
  // Pending share state — applied as soon as a video sender track exists.
  private desiredShareVideo = false;
  private poseChannel?: RTCDataChannel;
  private poseListeners = new Set<RemotePoseListener>();

  constructor(
    private multiplayer: MultiplayerClient,
    private getLocalStream: StreamProvider,
    private getMicStream: StreamProvider = () => undefined,
  ) {
    if (typeof RTCPeerConnection === 'undefined') {
      console.warn('[webrtc] RTCPeerConnection not supported in this browser');
      return;
    }

    multiplayer.onPartnerIdentity(identity => {
      this.partnerIdentity = identity;
      this.handlePartnerChange();
    });

    multiplayer.onSignal(signal => {
      void this.handleSignal(signal);
    });
  }

  onRemoteStream(listener: RemoteStreamListener): void {
    this.remoteListeners.add(listener);
    listener(this.remoteStream ?? null);
  }

  onRemotePose(listener: RemotePoseListener): void {
    this.poseListeners.add(listener);
  }

  sendPose(poseJson: string): void {
    const ch = this.poseChannel;
    if (!ch || ch.readyState !== 'open') return;
    try {
      ch.send(poseJson);
    } catch (err) {
      // Send on a closing channel can throw; not fatal — next negotiation
      // will rebuild a fresh channel.
      console.warn('[webrtc] pose send failed', err);
    }
  }

  /** Called by Game once the local MediaStream becomes available. */
  notifyLocalStreamReady(): void {
    if (!this.partnerIdentity) return;
    if (!this.pc) {
      this.maybeStartNegotiation();
      return;
    }
    this.syncLocalTracksAndRenegotiate('local stream ready');
  }

  /**
   * Called the first time the mic becomes available — typically when the user
   * clicks the Mic button. If a peer connection already exists, renegotiate
   * so the mic track ends up in the SDP.
   */
  notifyMicReady(): void {
    if (!this.partnerIdentity) return;
    if (!this.pc) {
      this.maybeStartNegotiation();
      return;
    }
    this.syncLocalTracksAndRenegotiate('mic ready');
  }

  dispose(): void {
    this.disposed = true;
    console.info('[webrtc] tearing down peer connection (reason: dispose)');
    this.teardownPeer();
  }

  private handlePartnerChange(): void {
    if (!this.partnerIdentity) {
      console.info('[webrtc] partner left; tearing down peer connection');
      this.teardownPeer();
      return;
    }
    if (this.pc) {
      console.info('[webrtc] partner changed; resetting peer connection');
      this.teardownPeer();
    }
    this.maybeStartNegotiation();
  }

  private isOfferer(): boolean {
    // Deterministic, identity-based: lower hex string offers. Both peers see
    // the same comparison the moment they know each other's identities — no
    // dependence on the (asynchronously assigned) seat index, which used to
    // cause both peers to default to seat 0 and glare on offer.
    if (!this.partnerIdentity) return false;
    return this.multiplayer.localId < this.partnerIdentity;
  }

  private isPolite(): boolean {
    // The polite peer yields on offer collision. With the offerer rule above,
    // the offerer is impolite and the answerer is polite — so any residual
    // glare resolves cleanly without manual rollback wiring.
    return !this.isOfferer();
  }

  private maybeStartNegotiation(): void {
    if (this.disposed) return;
    if (!this.partnerIdentity) {
      console.info('[webrtc] role: waiting (no partner identity)');
      return;
    }
    if (typeof RTCPeerConnection === 'undefined') return;

    const offerer = this.isOfferer();
    console.info(
      '[webrtc] role:', offerer ? 'offerer' : 'answerer',
      `(local=${this.multiplayer.localId.slice(0, 10)} partner=${this.partnerIdentity.slice(0, 10)})`
    );

    if (this.pc) return;

    this.pc = this.createPeerConnection();
    if (!this.pc) return;

    this.syncLocalTracks(this.pc);

    if (offerer) {
      // Unreliable + unordered keeps latency tight — a dropped pose frame is
      // never worth waiting for retransmits at 30+ Hz. The next frame is the
      // truth. Channel must be created before createOffer() so its m-line
      // ends up in the SDP.
      const channel = this.pc.createDataChannel(POSE_CHANNEL_LABEL, {
        ordered: false,
        maxRetransmits: 0,
      });
      this.wirePoseChannel(channel);
      void this.createAndSendOffer('initial');
    }
  }

  private createPeerConnection(): RTCPeerConnection | undefined {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch (err) {
      console.error('[webrtc] failed to construct RTCPeerConnection', err);
      return undefined;
    }

    pc.ontrack = event => {
      console.info('[webrtc] received remote track', event.track.kind, event.track.id);
      if (!this.remoteStream) this.remoteStream = new MediaStream();
      if (!this.remoteStream.getTrackById(event.track.id)) {
        this.remoteStream.addTrack(event.track);
      }
      event.track.onended = () => {
        if (!this.remoteStream) return;
        this.remoteStream.removeTrack(event.track);
        this.emitRemoteStream();
      };
      this.emitRemoteStream();
    };

    pc.onicecandidate = event => {
      if (!event.candidate || !this.partnerIdentity) return;
      void this.multiplayer.sendWebrtcSignal(
        this.partnerIdentity,
        'ice',
        JSON.stringify(event.candidate.toJSON())
      );
    };

    pc.oniceconnectionstatechange = () => {
      console.info('[webrtc] iceConnectionState', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        console.warn('[webrtc] ICE failed; attempting restart');
        try {
          pc.restartIce();
          // restartIce flips signaling state — drive negotiation now so a new
          // offer goes out with fresh ICE credentials.
          if (this.partnerIdentity && this.isOfferer()) {
            void this.createAndSendOffer('ice restart');
          }
        } catch (err) {
          console.error('[webrtc] restartIce failed; falling back to teardown', err);
          this.teardownPeer();
          this.maybeStartNegotiation();
        }
      }
    };

    pc.onconnectionstatechange = () => {
      console.info('[webrtc] connectionState', pc.connectionState);
    };

    pc.ondatachannel = event => {
      if (event.channel.label === POSE_CHANNEL_LABEL) {
        console.info('[webrtc] received pose channel');
        this.wirePoseChannel(event.channel);
      }
    };

    return pc;
  }

  private syncLocalTracksAndRenegotiate(reason: string): void {
    if (!this.pc || !this.partnerIdentity) return;
    const changed = this.syncLocalTracks(this.pc);
    if (changed) void this.createAndSendOffer(reason);
  }

  private syncLocalTracks(pc: RTCPeerConnection): boolean {
    let changed = false;
    const videoStream = this.getLocalStream();
    const micStream = this.getMicStream();

    if (!this.desiredShareVideo && this.videoSenderTrack) {
      const sender = pc.getSenders().find(s => s.track === this.videoSenderTrack);
      if (sender) {
        try {
          pc.removeTrack(sender);
          changed = true;
        } catch (err) {
          console.warn('[webrtc] removeTrack failed', err);
        }
      }
      try { this.videoSenderTrack.stop(); } catch { /* ignore */ }
      this.videoSenderTrack = undefined;
    }

    if (this.desiredShareVideo && videoStream && !this.videoSenderTrack) {
      const [track] = videoStream.getVideoTracks();
      if (track) {
        try {
          // Clone so the local hand-tracker / preview can keep running on the
          // original. The clone is only attached when Share Video is enabled.
          const clone = track.clone();
          clone.enabled = true;
          pc.addTrack(clone, videoStream);
          this.videoSenderTrack = clone;
          changed = true;
        } catch (err) {
          console.warn('[webrtc] addTrack failed', track.kind, err);
        }
      }
    }

    // If we previously attached a mic track but it has since ended (OS killed
    // it, permission revoked, hot-swap), drop the cached reference so the
    // block below can attach a fresh one. Without this, the sender holds a
    // dead track and partner audio silently disappears after a mic restart.
    if (this.audioSenderTrack && this.audioSenderTrack.readyState === 'ended') {
      const sender = pc.getSenders().find(s => s.track === this.audioSenderTrack);
      if (sender) {
        try {
          pc.removeTrack(sender);
          changed = true;
        } catch (err) {
          console.warn('[webrtc] removeTrack (ended mic) failed', err);
        }
      }
      this.audioSenderTrack = undefined;
    }

    if (micStream) {
      const [track] = micStream.getAudioTracks();
      if (track && !this.audioSenderTrack) {
        try {
          // Mic doesn't have a local-only consumer, so we hand the original
          // straight to the peer. Toggling the Mic icon disables capture +
          // transmission together (and the browser's mic indicator follows).
          pc.addTrack(track, micStream);
          this.audioSenderTrack = track;
          changed = true;
        } catch (err) {
          console.warn('[webrtc] addTrack failed', track.kind, err);
        }
      }
    }
    return changed;
  }

  private wirePoseChannel(channel: RTCDataChannel): void {
    if (this.poseChannel && this.poseChannel !== channel) {
      this.detachPoseChannel(this.poseChannel);
    }
    this.poseChannel = channel;
    channel.onopen = () => console.info('[webrtc] pose channel open');
    channel.onclose = () => console.info('[webrtc] pose channel closed');
    channel.onerror = err => console.warn('[webrtc] pose channel error', err);
    channel.onmessage = event => {
      const data = event.data;
      if (typeof data !== 'string') return;
      for (const listener of this.poseListeners) listener(data);
    };
  }

  private detachPoseChannel(channel: RTCDataChannel): void {
    channel.onopen = null;
    channel.onclose = null;
    channel.onerror = null;
    channel.onmessage = null;
    try { channel.close(); } catch { /* ignore */ }
  }

  setShareVideo(enabled: boolean): void {
    const changed = enabled !== this.desiredShareVideo;
    this.desiredShareVideo = enabled;
    if (this.videoSenderTrack) {
      this.videoSenderTrack.enabled = enabled;
    }
    if (changed) {
      if (!this.pc && this.partnerIdentity) {
        this.maybeStartNegotiation();
      } else {
        this.syncLocalTracksAndRenegotiate(enabled ? 'share video enabled' : 'share video disabled');
      }
    }
    console.info('[webrtc] share video', enabled ? 'enabled' : 'disabled');
  }

  getShareVideo(): boolean {
    return this.videoSenderTrack?.enabled ?? this.desiredShareVideo;
  }

  private async createAndSendOffer(reason: string): Promise<void> {
    if (!this.pc || !this.partnerIdentity) return;
    if (this.makingOffer || this.pc.signalingState !== 'stable') {
      this.queuedNegotiation = true;
      console.info('[webrtc] queued negotiation', reason, this.pc.signalingState);
      return;
    }
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      console.info('[webrtc] sending offer', reason);
      await this.multiplayer.sendWebrtcSignal(
        this.partnerIdentity,
        'offer',
        JSON.stringify(offer)
      );
    } catch (err) {
      console.error('[webrtc] createOffer/setLocalDescription failed', err);
      this.teardownPeer();
    } finally {
      this.makingOffer = false;
    }
  }

  private async handleSignal(signal: {
    id: bigint;
    senderId: string;
    kind: string;
    payload: string;
  }): Promise<void> {
    if (this.disposed) return;

    // Fallback: if a signal arrives before the partner-identity listener has
    // fired (player row updates can arrive after the signal row in the same
    // subscription batch), adopt the sender as our partner so we can answer.
    if (!this.partnerIdentity) {
      console.info('[webrtc] adopting partner identity from incoming signal',
        signal.senderId.slice(0, 10));
      this.partnerIdentity = signal.senderId;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(signal.payload);
    } catch (err) {
      console.warn('[webrtc] malformed payload', signal.kind, err);
      await this.multiplayer.consumeWebrtcSignal(signal.id);
      return;
    }

    try {
      if (signal.kind === 'offer') {
        await this.handleOffer(parsed as RTCSessionDescriptionInit);
      } else if (signal.kind === 'answer') {
        await this.handleAnswer(parsed as RTCSessionDescriptionInit);
      } else if (signal.kind === 'ice') {
        await this.handleIce(parsed as RTCIceCandidateInit);
      } else {
        console.warn('[webrtc] unknown signal kind', signal.kind);
      }
    } catch (err) {
      console.error('[webrtc] handleSignal', signal.kind, 'failed', err);
    } finally {
      await this.multiplayer.consumeWebrtcSignal(signal.id);
    }
  }

  private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) {
      this.pc = this.createPeerConnection();
      if (!this.pc) return;
    }
    this.syncLocalTracks(this.pc);

    // Perfect-negotiation collision handling. If we're mid-offer (or already
    // have a local offer set) and we're the impolite peer, drop the incoming
    // offer — ours wins. If we're polite, the implicit rollback inside
    // setRemoteDescription will switch us into answerer mode.
    const collision =
      this.makingOffer || this.pc.signalingState !== 'stable';
    if (collision && !this.isPolite()) {
      console.warn('[webrtc] offer collision; impolite peer ignoring inbound offer');
      return;
    }
    if (collision) {
      console.info('[webrtc] offer collision; polite peer rolling back');
    }

    await this.pc.setRemoteDescription(offer);
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (this.partnerIdentity) {
      console.info('[webrtc] sending answer');
      await this.multiplayer.sendWebrtcSignal(
        this.partnerIdentity,
        'answer',
        JSON.stringify(answer)
      );
    } else {
      console.warn('[webrtc] would send answer but partnerIdentity is null');
    }
    this.flushQueuedNegotiation();
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) {
      console.warn('[webrtc] answer received but no peer connection');
      return;
    }
    if (this.pc.signalingState !== 'have-local-offer') {
      console.warn(
        '[webrtc] answer received in unexpected state',
        this.pc.signalingState,
        '— ignoring'
      );
      return;
    }
    await this.pc.setRemoteDescription(answer);
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
    this.flushQueuedNegotiation();
  }

  private async handleIce(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || !this.remoteDescriptionSet) {
      this.pendingIceCandidates.push(candidate);
      return;
    }
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (err) {
      // ICE failures aren't fatal — they just mean one candidate didn't pan
      // out. Other candidates may still succeed. Logged at warn so we can
      // see them but not at error.
      console.warn('[webrtc] addIceCandidate failed', err);
    }
  }

  private async flushPendingIce(): Promise<void> {
    if (!this.pc) return;
    const queued = this.pendingIceCandidates;
    this.pendingIceCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('[webrtc] queued addIceCandidate failed', err);
      }
    }
  }

  private flushQueuedNegotiation(): void {
    if (!this.queuedNegotiation || !this.pc || this.pc.signalingState !== 'stable') return;
    this.queuedNegotiation = false;
    void this.createAndSendOffer('queued');
  }

  private emitRemoteStream(): void {
    const stream = this.remoteStream && this.remoteStream.getTracks().length > 0
      ? this.remoteStream
      : null;
    for (const listener of this.remoteListeners) listener(stream);
  }

  private teardownPeer(): void {
    if (this.pc) {
      try {
        this.pc.ontrack = null;
        this.pc.onicecandidate = null;
        this.pc.oniceconnectionstatechange = null;
        this.pc.onconnectionstatechange = null;
        this.pc.ondatachannel = null;
        if (this.poseChannel) {
          this.detachPoseChannel(this.poseChannel);
          this.poseChannel = undefined;
        }
        this.pc.close();
      } catch (err) {
        console.warn('[webrtc] error during dispose', err);
      }
      this.pc = undefined;
    }
    this.remoteDescriptionSet = false;
    this.pendingIceCandidates = [];
    if (this.videoSenderTrack) {
      try { this.videoSenderTrack.stop(); } catch { /* ignore */ }
      this.videoSenderTrack = undefined;
    }
    this.audioSenderTrack = undefined;
    if (this.remoteStream) {
      for (const track of this.remoteStream.getTracks()) {
        this.remoteStream.removeTrack(track);
      }
      this.remoteStream = undefined;
      for (const listener of this.remoteListeners) listener(null);
    }
  }
}
