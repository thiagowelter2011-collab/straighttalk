// Motores de voz e tela do StraightTalk.
//
// P2PEngine:     cada pessoa conecta direto com cada outra (WebRTC em malha).
//                Menor delay possível; ideal para grupos pequenos.
// LiveKitEngine: todos conectam num servidor de mídia (SFU). Aguenta salas grandes,
//                atravessa redes fechadas (TURN embutido) e adapta a qualidade.
//
// Os dois expõem a mesma interface para o app:
//   join(channelId) -> mediaId · leave() · setMuted(b) · setDeafened(b) · setVolume(mediaId, v)
//   startShare({ mode, audio }) -> streamId · stopShare() · localScreen
//   callbacks: onScreen(mediaId, stream|null, el?) · onSpeaking(mediaId, bool) · onShareEnded() · onDisconnected()

(function () {
  const MIC_CONSTRAINTS = (deviceId, noiseSuppression = true) => ({
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true,
    noiseSuppression,
    autoGainControl: true,
  });

  // Detecta fala analisando o volume (usado no modo P2P e para o próprio microfone)
  let audioCtx;
  function watchLevel(stream, onChange) {
    audioCtx ||= new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let lastLoud = 0;
    let speaking = false;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState === 'ended') { if (speaking) onChange(false); return; }
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += (v - 128) ** 2;
      const now = performance.now();
      if (Math.sqrt(sum / data.length) > 4 && track.enabled) lastLoud = now;
      const s = now - lastLoud < 250;
      if (s !== speaking) { speaking = s; onChange(s); }
      setTimeout(tick, 80);
    };
    tick();
    return () => { stopped = true; try { src.disconnect(); } catch {} };
  }

  async function getMic(settings) {
    return navigator.mediaDevices.getUserMedia({
      audio: MIC_CONSTRAINTS(settings.micId, settings.noiseSuppression !== false),
      video: false,
    });
  }

  function applySink(el, sinkId) {
    if (sinkId && typeof el.setSinkId === 'function') el.setSinkId(sinkId).catch(() => {});
  }

  function displayMediaOptions({ mode, audio }) {
    const motion = mode === 'motion';
    return {
      video: { frameRate: { ideal: motion ? 60 : 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: audio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
      systemAudio: audio ? 'include' : 'exclude',
      selfBrowserSurface: 'exclude',
    };
  }

  /* ======================================================================= */

  class P2PEngine {
    constructor({ send, iceServers, myConnId, settings, callbacks }) {
      this.send = send;
      this.iceServers = iceServers;
      this.myConnId = myConnId;
      this.settings = settings;
      this.cb = callbacks;
      this.peers = new Map();   // connId -> peer
      this.mic = null;
      this.localScreen = null;
      this.screenMode = 'motion';
      this.muted = false;
      this.deafened = false;
      this.volumes = new Map();
      this.screenStreamIds = new Map(); // connId -> id da stream de tela
    }

    async join() {
      try {
        this.mic = await getMic(this.settings);
        this.stopMicWatch = watchLevel(this.mic, (s) => this.cb.onSpeaking(this.myConnId, s));
      } catch (err) {
        this.mic = null;
        this.cb.onMicError?.(err);
      }
      this.applyMute();
      return this.myConnId;
    }

    // Lista de quem está no canal (vinda do servidor): cria/remove conexões
    updateParticipants(list) {
      const ids = new Set(list.map((p) => p.connId).filter((id) => id !== this.myConnId));
      for (const p of list) if (p.screenStream) this.screenStreamIds.set(p.connId, p.screenStream);
      for (const id of ids) if (!this.peers.has(id)) this.addPeer(id);
      for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.removePeer(id);
    }

    addPeer(id) {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
      const peer = { id, pc, polite: this.myConnId < id, makingOffer: false, ignoreOffer: false, audio: new Map(), screenSenders: [], stops: [] };
      this.peers.set(id, peer);

      this.mic?.getTracks().forEach((t) => pc.addTrack(t, this.mic));
      if (this.localScreen) this.addScreenTo(peer);

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          this.send({ type: 'signal', to: id, data: { description: pc.localDescription } });
        } catch (err) {
          console.error(err);
        } finally {
          peer.makingOffer = false;
        }
      };
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) this.send({ type: 'signal', to: id, data: { candidate } });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') pc.restartIce();
      };
      pc.ontrack = ({ track, streams, receiver }) => {
        try { receiver.jitterBufferTarget = 0; } catch {}
        try { receiver.playoutDelayHint = 0; } catch {}
        const stream = streams[0] || new MediaStream([track]);
        if (track.kind === 'audio') {
          const el = new Audio();
          el.autoplay = true;
          el.srcObject = new MediaStream([track]);
          el.volume = this.volumes.get(id) ?? 1;
          el.muted = this.deafened;
          applySink(el, this.settings.speakerId);
          document.getElementById('audio-sink').appendChild(el);
          el.play().catch(() => {});
          peer.audio.set(track.id, el);
          peer.stops.push(watchLevel(el.srcObject, (s) => {
            if (stream.id !== this.screenStreamIds.get(id)) this.cb.onSpeaking(id, s);
          }));
        } else {
          this.cb.onScreen(id, stream);
        }
        stream.onremovetrack = ({ track: t }) => {
          const el = peer.audio.get(t.id);
          if (el) { el.remove(); peer.audio.delete(t.id); }
          if (!stream.getVideoTracks().length) this.cb.onScreen(id, null);
        };
      };
    }

    removePeer(id) {
      const p = this.peers.get(id);
      if (!p) return;
      p.pc.close();
      p.audio.forEach((el) => el.remove());
      p.stops.forEach((s) => s());
      this.peers.delete(id);
      this.cb.onScreen(id, null);
      this.cb.onSpeaking(id, false);
    }

    async handleSignal(from, { description, candidate }) {
      const peer = this.peers.get(from);
      if (!peer) return;
      const pc = peer.pc;
      try {
        if (description) {
          const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
          peer.ignoreOffer = !peer.polite && collision;
          if (peer.ignoreOffer) return;
          await pc.setRemoteDescription(description);
          if (description.type === 'offer') {
            await pc.setLocalDescription();
            this.send({ type: 'signal', to: from, data: { description: pc.localDescription } });
          }
        } else if (candidate) {
          try { await pc.addIceCandidate(candidate); } catch (err) { if (!peer.ignoreOffer) throw err; }
        }
      } catch (err) {
        console.error('Erro de sinalização', err);
      }
    }

    applyMute() {
      this.mic?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    }

    setMuted(b) { this.muted = b; this.applyMute(); }

    setDeafened(b) {
      this.deafened = b;
      for (const p of this.peers.values()) p.audio.forEach((el) => { el.muted = b; });
    }

    setVolume(id, v) {
      this.volumes.set(id, v);
      this.peers.get(id)?.audio.forEach((el) => { el.volume = v; });
    }

    setSpeaker(sinkId) {
      this.settings.speakerId = sinkId;
      for (const p of this.peers.values()) p.audio.forEach((el) => applySink(el, sinkId));
    }

    async startShare(opts) {
      this.screenMode = opts.mode;
      this.localScreen = await navigator.mediaDevices.getDisplayMedia(displayMediaOptions(opts));
      const [video] = this.localScreen.getVideoTracks();
      video.contentHint = opts.mode === 'motion' ? 'motion' : 'detail';
      video.onended = () => { this.stopShare(); this.cb.onShareEnded(); };
      for (const peer of this.peers.values()) this.addScreenTo(peer);
      return this.localScreen.id;
    }

    addScreenTo(peer) {
      const motion = this.screenMode === 'motion';
      peer.screenSenders = this.localScreen.getTracks().map((t) => {
        const sender = peer.pc.addTrack(t, this.localScreen);
        if (t.kind === 'video') {
          // Jogo: mantém o fps e reduz a resolução se a rede apertar. Texto: o contrário.
          const params = sender.getParameters();
          params.degradationPreference = motion ? 'maintain-framerate' : 'maintain-resolution';
          if (!params.encodings?.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = motion ? 6_000_000 : 3_000_000;
          params.encodings[0].maxFramerate = motion ? 60 : 30;
          sender.setParameters(params).catch(() => {});
        }
        return sender;
      });
    }

    stopShare() {
      if (!this.localScreen) return;
      this.localScreen.getTracks().forEach((t) => t.stop());
      for (const peer of this.peers.values()) {
        peer.screenSenders.forEach((s) => { try { peer.pc.removeTrack(s); } catch {} });
        peer.screenSenders = [];
      }
      this.localScreen = null;
    }

    leave() {
      this.stopShare();
      for (const id of [...this.peers.keys()]) this.removePeer(id);
      this.stopMicWatch?.();
      this.mic?.getTracks().forEach((t) => t.stop());
      this.mic = null;
    }
  }

  /* ======================================================================= */

  class LiveKitEngine {
    constructor({ getToken, settings, callbacks }) {
      this.getToken = getToken;
      this.settings = settings;
      this.cb = callbacks;
      this.room = null;
      this.localScreen = null;
      this.muted = false;
      this.deafened = false;
      this.volumes = new Map();
      this.speaking = new Set();
    }

    async join(channelId) {
      const LK = window.LivekitClient;
      const { url, token, identity } = await this.getToken(channelId);
      this.identity = identity;
      const room = new LK.Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: MIC_CONSTRAINTS(this.settings.micId, this.settings.noiseSuppression !== false),
        audioOutput: this.settings.speakerId ? { deviceId: this.settings.speakerId } : undefined,
        publishDefaults: { dtx: true, red: true },
      });
      this.room = room;
      const E = LK.RoomEvent;

      room.on(E.TrackSubscribed, (track, pub, participant) => {
        const id = participant.identity;
        if (track.kind === 'audio') {
          const el = track.attach();
          document.getElementById('audio-sink').appendChild(el);
          this.applyParticipantVolume(participant);
        } else if (track.source === LK.Track.Source.ScreenShare) {
          const video = document.createElement('video');
          video.autoplay = true;
          video.playsInline = true;
          video.muted = true;
          track.attach(video);
          this.cb.onScreen(id, new MediaStream([track.mediaStreamTrack]), video);
        }
      });
      room.on(E.TrackUnsubscribed, (track, pub, participant) => {
        track.detach().forEach((el) => el.remove());
        if (track.source === LK.Track.Source.ScreenShare) this.cb.onScreen(participant.identity, null);
      });
      room.on(E.ParticipantConnected, (p) => this.applyParticipantVolume(p));
      room.on(E.ParticipantDisconnected, (p) => {
        this.cb.onScreen(p.identity, null);
        this.cb.onSpeaking(p.identity, false);
      });
      room.on(E.ActiveSpeakersChanged, (speakers) => {
        const now = new Set(speakers.map((s) => s.identity));
        for (const id of this.speaking) if (!now.has(id)) this.cb.onSpeaking(id, false);
        for (const id of now) if (!this.speaking.has(id)) this.cb.onSpeaking(id, true);
        this.speaking = now;
      });
      room.on(E.LocalTrackUnpublished, (pub) => {
        if (pub.source === LK.Track.Source.ScreenShare && this.localScreen) {
          this.localScreen = null;
          this.cb.onShareEnded();
        }
      });
      room.on(E.Disconnected, () => {
        if (this.room === room) this.cb.onDisconnected?.();
      });

      await room.connect(url, token, { autoSubscribe: true });
      try {
        await room.localParticipant.setMicrophoneEnabled(!this.muted);
      } catch (err) {
        this.cb.onMicError?.(err);
      }
      room.startAudio().catch(() => {});
      return identity;
    }

    applyParticipantVolume(p) {
      if (typeof p.setVolume !== 'function') return;
      p.setVolume(this.deafened ? 0 : (this.volumes.get(p.identity) ?? 1));
    }

    setMuted(b) {
      this.muted = b;
      this.room?.localParticipant.setMicrophoneEnabled(!b).catch((err) => this.cb.onMicError?.(err));
    }

    setDeafened(b) {
      this.deafened = b;
      this.room?.remoteParticipants.forEach((p) => this.applyParticipantVolume(p));
    }

    setVolume(id, v) {
      this.volumes.set(id, v);
      const p = this.room?.remoteParticipants.get(id);
      if (p) this.applyParticipantVolume(p);
    }

    setSpeaker(sinkId) {
      this.settings.speakerId = sinkId;
      this.room?.switchActiveDevice('audiooutput', sinkId).catch(() => {});
    }

    async startShare({ mode, audio }) {
      const LK = window.LivekitClient;
      const motion = mode === 'motion';
      const pub = await this.room.localParticipant.setScreenShareEnabled(true, {
        audio,
        systemAudio: audio ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude',
        contentHint: motion ? 'motion' : 'detail',
        resolution: { width: 1920, height: 1080, frameRate: motion ? 60 : 30 },
      }, {
        screenShareEncoding: { maxBitrate: motion ? 6_000_000 : 3_000_000, maxFramerate: motion ? 60 : 30 },
        degradationPreference: motion ? 'maintain-framerate' : 'maintain-resolution',
      });
      if (!pub?.track) throw Object.assign(new Error('cancelado'), { name: 'NotAllowedError' });
      this.localScreen = new MediaStream([pub.track.mediaStreamTrack]);
      void LK;
      return this.localScreen.id;
    }

    stopShare() {
      if (!this.localScreen) return;
      this.localScreen = null;
      this.room?.localParticipant.setScreenShareEnabled(false).catch(() => {});
    }

    leave() {
      const room = this.room;
      this.room = null;
      this.localScreen = null;
      room?.disconnect();
    }

    updateParticipants() {}
    handleSignal() {}
  }

  window.StraightTalkMedia = { P2PEngine, LiveKitEngine, watchLevel };
})();
