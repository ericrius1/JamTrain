import type { MultiplayerClient } from './multiplayer';

type RemoteStreamListener = (stream: MediaStream | null) => void;
type StreamProvider = () => MediaStream | undefined;
type RemotePoseListener = (poseJson: string) => void;
export type PeerState = { instrument?: string; creature?: string };
type RemoteStateListener = (state: PeerState) => void;
type LocalStateProvider = () => PeerState;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

const POSE_CHANNEL_LABEL = 'pose';
const STATE_CHANNEL_LABEL = 'state';

export class WebRTCClient {
  private pc?: RTCPeerConnection;
  private remoteStream?: MediaStream;
  private remoteListeners = new Set<RemoteStreamListener>();
  private partnerIdentity: string | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private makingOffer = false;
  private disposed = false;
  // Cloned video track that we hand to the peer connection. Kept independent
  // of HandTracker's original so the user can have local tracking on without
  // sharing video with the partner (and vice versa).
  private videoSenderTrack?: MediaStreamTrack;
  // Pending share state — applied as soon as a video sender track exists.
  private desiredShareVideo = false;
  private poseChannel?: RTCDataChannel;
  private poseListeners = new Set<RemotePoseListener>();
  private stateChannel?: RTCDataChannel;
  private stateListeners = new Set<RemoteStateListener>();
  private getLocalState: LocalStateProvider = () => ({});

  constructor(
    private multiplayer: MultiplayerClient,
    private getLocalStream: StreamProvider
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

  setLocalStateProvider(provider: LocalStateProvider): void {
    this.getLocalState = provider;
  }

  onRemoteState(listener: RemoteStateListener): void {
    this.stateListeners.add(listener);
  }

  sendState(state: PeerState): void {
    const ch = this.stateChannel;
    if (!ch || ch.readyState !== 'open') return;
    try {
      ch.send(JSON.stringify(state));
    } catch (err) {
      console.warn('[webrtc] state send failed', err);
    }
  }

  /** Called by Game once the local MediaStream becomes available. */
  notifyLocalStreamReady(): void {
    if (this.partnerIdentity && !this.pc) this.maybeStartNegotiation();
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

    this.pc = this.createPeerConnection();
    if (!this.pc) return;

    if (!this.attachLocalTracks(this.pc)) {
      console.warn('[webrtc] no local stream yet; deferring negotiation');
      this.teardownPeer();
      return;
    }

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
      // State channel is reliable + ordered — instrument/creature changes
      // must not drop, and arrival order matters (last write wins).
      const stateCh = this.pc.createDataChannel(STATE_CHANNEL_LABEL);
      this.wireStateChannel(stateCh);
      void this.createAndSendOffer();
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
      const [stream] = event.streams;
      if (!stream) return;
      console.info('[webrtc] received remote track', event.track.kind, event.track.id);
      this.remoteStream = stream;
      for (const listener of this.remoteListeners) listener(stream);
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
        console.error('[webrtc] connection failed; common cause is symmetric NAT (no TURN configured)');
      }
    };

    pc.onconnectionstatechange = () => {
      console.info('[webrtc] connectionState', pc.connectionState);
    };

    pc.ondatachannel = event => {
      if (event.channel.label === POSE_CHANNEL_LABEL) {
        console.info('[webrtc] received pose channel');
        this.wirePoseChannel(event.channel);
      } else if (event.channel.label === STATE_CHANNEL_LABEL) {
        console.info('[webrtc] received state channel');
        this.wireStateChannel(event.channel);
      }
    };

    return pc;
  }

  private attachLocalTracks(pc: RTCPeerConnection): boolean {
    const stream = this.getLocalStream();
    if (!stream) return false;
    for (const track of stream.getTracks()) {
      try {
        if (track.kind === 'video') {
          // Clone so the local hand-tracker / preview can keep running on the
          // original even when we mute partner-facing video. The clone has
          // its own enabled flag that the Share Video toggle controls.
          const clone = track.clone();
          clone.enabled = this.desiredShareVideo;
          pc.addTrack(clone, stream);
          this.videoSenderTrack = clone;
        } else {
          // Mic doesn't have a local-only consumer, so we hand the original
          // straight to the peer. Toggling the Mic icon disables capture +
          // transmission together (and the browser's mic indicator follows).
          pc.addTrack(track, stream);
        }
      } catch (err) {
        console.warn('[webrtc] addTrack failed', track.kind, err);
      }
    }
    return true;
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

  private wireStateChannel(channel: RTCDataChannel): void {
    if (this.stateChannel && this.stateChannel !== channel) {
      this.detachStateChannel(this.stateChannel);
    }
    this.stateChannel = channel;
    channel.onopen = () => {
      console.info('[webrtc] state channel open');
      // Send a snapshot so the partner doesn't have to wait for the next
      // change to learn what we're playing right now.
      this.sendState(this.getLocalState());
    };
    channel.onclose = () => console.info('[webrtc] state channel closed');
    channel.onerror = err => console.warn('[webrtc] state channel error', err);
    channel.onmessage = event => {
      const data = event.data;
      if (typeof data !== 'string') return;
      let parsed: PeerState | null = null;
      try {
        parsed = JSON.parse(data) as PeerState;
      } catch (err) {
        console.warn('[webrtc] state channel: malformed payload', err);
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      for (const listener of this.stateListeners) listener(parsed);
    };
  }

  private detachStateChannel(channel: RTCDataChannel): void {
    channel.onopen = null;
    channel.onclose = null;
    channel.onerror = null;
    channel.onmessage = null;
    try { channel.close(); } catch { /* ignore */ }
  }

  setShareVideo(enabled: boolean): void {
    this.desiredShareVideo = enabled;
    if (this.videoSenderTrack) {
      this.videoSenderTrack.enabled = enabled;
    }
    console.info('[webrtc] share video', enabled ? 'enabled' : 'disabled');
  }

  getShareVideo(): boolean {
    return this.videoSenderTrack?.enabled ?? this.desiredShareVideo;
  }

  private async createAndSendOffer(): Promise<void> {
    if (!this.pc || !this.partnerIdentity) return;
    try {
      this.makingOffer = true;
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      console.info('[webrtc] sending offer');
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
      this.attachLocalTracks(this.pc);
    }

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
        if (this.stateChannel) {
          this.detachStateChannel(this.stateChannel);
          this.stateChannel = undefined;
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
    if (this.remoteStream) {
      this.remoteStream = undefined;
      for (const listener of this.remoteListeners) listener(null);
    }
  }
}
