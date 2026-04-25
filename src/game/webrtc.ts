import type { MultiplayerClient } from './multiplayer';

type RemoteStreamListener = (stream: MediaStream | null) => void;
type StreamProvider = () => MediaStream | undefined;
type SeatProvider = () => number;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export class WebRTCClient {
  private pc?: RTCPeerConnection;
  private remoteStream?: MediaStream;
  private remoteListeners = new Set<RemoteStreamListener>();
  private partnerIdentity: string | null = null;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private remoteDescriptionSet = false;
  private disposed = false;

  constructor(
    private multiplayer: MultiplayerClient,
    private getLocalStream: StreamProvider,
    private getLocalSeat: SeatProvider
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

  private maybeStartNegotiation(): void {
    if (this.disposed) return;
    if (!this.partnerIdentity) {
      console.info('[webrtc] role: waiting (no partner identity)');
      return;
    }
    if (typeof RTCPeerConnection === 'undefined') return;

    const isOfferer = this.getLocalSeat() === 0;
    console.info('[webrtc] role:', isOfferer ? 'offerer' : 'answerer');

    this.pc = this.createPeerConnection();
    if (!this.pc) return;

    if (!this.attachLocalTracks(this.pc)) {
      console.warn('[webrtc] no local stream yet; deferring negotiation');
      this.teardownPeer();
      return;
    }

    if (isOfferer) {
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

    return pc;
  }

  private attachLocalTracks(pc: RTCPeerConnection): boolean {
    const stream = this.getLocalStream();
    if (!stream) return false;
    for (const track of stream.getTracks()) {
      try {
        pc.addTrack(track, stream);
      } catch (err) {
        console.warn('[webrtc] addTrack failed', track.kind, err);
      }
    }
    return true;
  }

  private async createAndSendOffer(): Promise<void> {
    if (!this.pc || !this.partnerIdentity) return;
    try {
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      await this.multiplayer.sendWebrtcSignal(
        this.partnerIdentity,
        'offer',
        JSON.stringify(offer)
      );
    } catch (err) {
      console.error('[webrtc] createOffer/setLocalDescription failed', err);
      this.teardownPeer();
    }
  }

  private async handleSignal(signal: {
    id: bigint;
    senderId: string;
    kind: string;
    payload: string;
  }): Promise<void> {
    if (this.disposed) return;

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
    await this.pc.setRemoteDescription(offer);
    this.remoteDescriptionSet = true;
    await this.flushPendingIce();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    if (this.partnerIdentity) {
      await this.multiplayer.sendWebrtcSignal(
        this.partnerIdentity,
        'answer',
        JSON.stringify(answer)
      );
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
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
        this.pc.close();
      } catch (err) {
        console.warn('[webrtc] error during dispose', err);
      }
      this.pc = undefined;
    }
    this.remoteDescriptionSet = false;
    this.pendingIceCandidates = [];
    if (this.remoteStream) {
      this.remoteStream = undefined;
      for (const listener of this.remoteListeners) listener(null);
    }
  }
}
