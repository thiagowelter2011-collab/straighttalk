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
//   startCamera({ deviceId }) -> streamId · stopCamera() · localCamera
//   callbacks: onScreen(mediaId, stream|null, el?) · onCamera(mediaId, stream|null, el?) · onSpeaking(mediaId, bool)
//              onShareEnded() · onCameraEnded() · onDisconnected()

(function () {
  // Supressão de ruído: 'ai' (RNNoise, tira teclado, ventilador e barulho de fundo), 'browser' (a do navegador) ou 'off'
  function noiseMode(settings) {
    const m = settings.noiseMode || (settings.noiseSuppression === false ? 'off' : 'ai');
    return m === 'ai' && !Denoise.supported() ? 'browser' : m;
  }

  const MIC_CONSTRAINTS = (deviceId, mode = 'browser') => ({
    deviceId: deviceId ? { exact: deviceId } : undefined,
    echoCancellation: true,
    // Com a IA ligada, a do navegador fica desligada para as duas não brigarem
    noiseSuppression: mode === 'browser',
    autoGainControl: true,
  });

  // RNNoise (rede neural pequena, roda no próprio computador) num AudioWorklet
  const Denoise = {
    ctx: null,
    wasm: null,
    loading: null,
    supported: () => typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined',
    load() {
      this.loading ||= (async () => {
        const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
        await ctx.audioWorklet.addModule('/vendor/noise/rnnoise-worklet.js');
        const simd = WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
        const res = await fetch(simd ? '/vendor/noise/rnnoise_simd.wasm' : '/vendor/noise/rnnoise.wasm');
        if (!res.ok) throw new Error('rnnoise indisponível');
        this.wasm = await res.arrayBuffer();
        this.ctx = ctx;
      })();
      this.loading.catch(() => { this.loading = null; });
      return this.loading;
    },
    // Recebe a trilha do microfone e devolve outra, já limpa
    async process(track) {
      await this.load();
      if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
      const src = this.ctx.createMediaStreamSource(new MediaStream([track]));
      const node = new AudioWorkletNode(this.ctx, '@sapphi-red/web-noise-suppressor/rnnoise', {
        processorOptions: { maxChannels: 1, wasmBinary: this.wasm },
      });
      const dest = this.ctx.createMediaStreamDestination();
      src.connect(node).connect(dest);
      const out = dest.stream.getAudioTracks()[0];
      return {
        track: out,
        stop() {
          try { src.disconnect(); node.disconnect(); } catch {}
          node.port.postMessage('destroy');
          out.stop();
        },
      };
    },
  };

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

  // Microfone pronto para enviar; com a IA ligada, já passa pelo RNNoise (se falhar, segue sem)
  async function getMic(settings) {
    const mode = noiseMode(settings);
    const raw = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS(settings.micId, mode), video: false });
    if (mode !== 'ai') return { stream: raw, stop: () => raw.getTracks().forEach((t) => t.stop()) };
    try {
      const d = await Denoise.process(raw.getAudioTracks()[0]);
      return { stream: new MediaStream([d.track]), stop: () => { d.stop(); raw.getTracks().forEach((t) => t.stop()); } };
    } catch (err) {
      console.warn('Supressão de ruído por IA indisponível:', err);
      return { stream: raw, stop: () => raw.getTracks().forEach((t) => t.stop()) };
    }
  }

  // Câmera: 720p a 30 fps (o navegador reduz se a câmera não alcançar)
  function cameraConstraints(deviceId) {
    return {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 },
    };
  }

  function applySink(el, sinkId) {
    if (sinkId && typeof el.setSinkId === 'function') el.setSinkId(sinkId).catch(() => {});
  }

  // Qualidade da tela, para todo mundo (sem plano pago): até 4K. Jogo/vídeo = 60 fps; texto/código = 30 fps com mais nitidez.
  const SHARE_QUALITY = {
    '720': { width: 1280, height: 720, motion: 4_000_000, detail: 2_000_000 },
    '1080': { width: 1920, height: 1080, motion: 6_000_000, detail: 3_000_000 },
    '1440': { width: 2560, height: 1440, motion: 10_000_000, detail: 5_000_000 },
    source: { width: 3840, height: 2160, motion: 16_000_000, detail: 8_000_000 },
  };

  function shareProfile({ mode, quality }) {
    const q = SHARE_QUALITY[quality] || SHARE_QUALITY['1080'];
    const motion = mode === 'motion';
    return { width: q.width, height: q.height, fps: motion ? 60 : 30, bitrate: motion ? q.motion : q.detail, motion };
  }

  function displayMediaOptions(opts) {
    const { audio } = opts;
    const p = shareProfile(opts);
    return {
      video: { frameRate: { ideal: p.fps, max: p.fps }, width: { ideal: p.width }, height: { ideal: p.height } },
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
      this.cameraStreamIds = new Map(); // connId -> id da stream da câmera
      this.localCamera = null;
    }

    async join() {
      try {
        const mic = await getMic(this.settings);
        this.mic = mic.stream;
        this.stopMicRaw = mic.stop;
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
      for (const p of list) {
        if (p.screenStream) this.screenStreamIds.set(p.connId, p.screenStream);
        if (p.cameraStream) this.cameraStreamIds.set(p.connId, p.cameraStream); else this.cameraStreamIds.delete(p.connId);
      }
      for (const id of ids) if (!this.peers.has(id)) this.addPeer(id);
      for (const id of [...this.peers.keys()]) if (!ids.has(id)) this.removePeer(id);
      for (const peer of this.peers.values()) this.classify(peer);
    }

    // Cada vídeo recebido é tela ou câmera, conforme o id da stream que a pessoa anunciou
    classify(peer) {
      const camId = this.cameraStreamIds.get(peer.id);
      let screen = null;
      let camera = null;
      for (const st of peer.video.values()) {
        if (st.id === camId) camera = st; else screen = st;
      }
      if (peer.shownScreen !== screen) { peer.shownScreen = screen; this.cb.onScreen(peer.id, screen); }
      if (peer.shownCamera !== camera) { peer.shownCamera = camera; this.cb.onCamera?.(peer.id, camera); }
    }

    addPeer(id) {
      const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
      const peer = { id, pc, polite: this.myConnId < id, makingOffer: false, ignoreOffer: false, audio: new Map(), video: new Map(), screenSenders: [], cameraSenders: [], stops: [], shownScreen: null, shownCamera: null };
      this.peers.set(id, peer);

      this.mic?.getTracks().forEach((t) => pc.addTrack(t, this.mic));
      if (this.localScreen) this.addScreenTo(peer);
      if (this.localCamera) this.addCameraTo(peer);
      // Quem começa a conversa é sempre o lado "impolite": evita os dois mandarem oferta ao mesmo tempo
      // (essa colisão às vezes deixava a conexão parada). Sem microfone, ainda assim abre o canal de áudio para ouvir.
      if (!peer.polite && !this.mic) pc.addTransceiver('audio', { direction: 'recvonly' });

      pc.onnegotiationneeded = () => {
        if (peer.polite && !peer.gotOffer) return; // espera a primeira oferta do outro lado
        this.offer(peer);
      };
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) this.send({ type: 'signal', to: id, data: { candidate } });
      };
      // Conexão direta que não conecta (rede fechada, sem TURN): avisa para a chamada passar ao servidor de mídia
      pc.onconnectionstatechange = () => {
        if (pc.connectionState !== 'failed') return;
        if (peer.restarted) this.cb.onP2PFailed?.(); else { peer.restarted = true; pc.restartIce(); }
      };
      const slow = setTimeout(() => { if (this.peers.get(id) === peer && pc.connectionState !== 'connected') this.cb.onP2PFailed?.(); }, 10000);
      peer.stops.push(() => clearTimeout(slow));
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
          peer.video.set(stream.id, stream);
          this.classify(peer);
        }
        stream.onremovetrack = ({ track: t }) => {
          const el = peer.audio.get(t.id);
          if (el) { el.remove(); peer.audio.delete(t.id); }
          if (!stream.getVideoTracks().length && peer.video.delete(stream.id)) this.classify(peer);
        };
      };
      return peer;
    }

    removePeer(id) {
      const p = this.peers.get(id);
      if (!p) return;
      p.pc.close();
      p.audio.forEach((el) => el.remove());
      p.stops.forEach((s) => s());
      this.peers.delete(id);
      this.cb.onScreen(id, null);
      this.cb.onCamera?.(id, null);
      this.cb.onSpeaking(id, false);
    }

    async offer(peer) {
      try {
        peer.makingOffer = true;
        await peer.pc.setLocalDescription();
        this.send({ type: 'signal', to: peer.id, data: { description: peer.pc.localDescription } });
      } catch (err) {
        console.error(err);
      } finally {
        peer.makingOffer = false;
      }
    }

    async handleSignal(from, { description, candidate }) {
      // O sinal pode chegar antes da lista de participantes: cria a conexão na hora (o servidor só repassa sinais do mesmo canal)
      const peer = this.peers.get(from) || (from !== this.myConnId && this.addPeer(from));
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
            // Primeira oferta recebida: se algo daqui (tela, câmera) ficou de fora, manda uma oferta agora
            if (!peer.gotOffer) {
              peer.gotOffer = true;
              if (pc.getTransceivers().some((t) => t.sender.track && !t.mid)) this.offer(peer);
            }
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
      this.screenProfile = shareProfile(opts);
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
          params.encodings[0].maxBitrate = this.screenProfile.bitrate;
          params.encodings[0].maxFramerate = this.screenProfile.fps;
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

    async startCamera({ deviceId } = {}) {
      this.localCamera = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints(deviceId), audio: false });
      const [video] = this.localCamera.getVideoTracks();
      video.contentHint = 'motion';
      video.onended = () => { this.stopCamera(); this.cb.onCameraEnded?.(); };
      for (const peer of this.peers.values()) this.addCameraTo(peer);
      return this.localCamera.id;
    }

    addCameraTo(peer) {
      peer.cameraSenders = this.localCamera.getTracks().map((t) => {
        const sender = peer.pc.addTrack(t, this.localCamera);
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = 1_500_000;
        sender.setParameters(params).catch(() => {});
        return sender;
      });
    }

    stopCamera() {
      if (!this.localCamera) return;
      this.localCamera.getTracks().forEach((t) => t.stop());
      for (const peer of this.peers.values()) {
        peer.cameraSenders.forEach((s) => { try { peer.pc.removeTrack(s); } catch {} });
        peer.cameraSenders = [];
      }
      this.localCamera = null;
    }

    leave() {
      this.stopShare();
      this.stopCamera();
      for (const id of [...this.peers.keys()]) this.removePeer(id);
      this.stopMicWatch?.();
      this.stopMicRaw?.();
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
      this.localCamera = null;
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
        // Escolhe a camada de vídeo pelo tamanho real na tela (telas de alta resolução recebem a qualidade cheia)
        adaptiveStream: { pixelDensity: 'screen' },
        dynacast: true,
        audioCaptureDefaults: MIC_CONSTRAINTS(this.settings.micId, noiseMode(this.settings)),
        audioOutput: this.settings.speakerId ? { deviceId: this.settings.speakerId } : undefined,
        publishDefaults: { dtx: true, red: true },
      });
      this.room = room;
      const E = LK.RoomEvent;

      room.on(E.TrackSubscribed, (track, pub, participant) => {
        const id = participant.identity;
        // Toca assim que chega, sem guardar no buffer (igual ao modo P2P)
        try { track.setPlayoutDelay?.(0); } catch {}
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
        } else if (track.source === LK.Track.Source.Camera) {
          const video = document.createElement('video');
          video.autoplay = true;
          video.playsInline = true;
          video.muted = true;
          track.attach(video);
          this.cb.onCamera?.(id, new MediaStream([track.mediaStreamTrack]), video);
        }
      });
      room.on(E.TrackUnsubscribed, (track, pub, participant) => {
        track.detach().forEach((el) => el.remove());
        if (track.source === LK.Track.Source.ScreenShare) this.cb.onScreen(participant.identity, null);
        if (track.source === LK.Track.Source.Camera) this.cb.onCamera?.(participant.identity, null);
      });
      room.on(E.ParticipantConnected, (p) => this.applyParticipantVolume(p));
      room.on(E.ParticipantDisconnected, (p) => {
        this.cb.onScreen(p.identity, null);
        this.cb.onCamera?.(p.identity, null);
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
        if (pub.source === LK.Track.Source.Camera && this.localCamera) {
          this.localCamera = null;
          this.cb.onCameraEnded?.();
        }
      });
      room.on(E.Disconnected, () => {
        if (this.room === room) this.cb.onDisconnected?.();
      });

      await room.connect(url, token, { autoSubscribe: true });
      try {
        await room.localParticipant.setMicrophoneEnabled(!this.muted);
        await this.ensureDenoise();
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
      this.room?.localParticipant.setMicrophoneEnabled(!b).then(() => this.ensureDenoise()).catch((err) => this.cb.onMicError?.(err));
    }

    // Liga o RNNoise na trilha do microfone do LiveKit (processador de trilha)
    async ensureDenoise() {
      if (noiseMode(this.settings) !== 'ai') return;
      const LK = window.LivekitClient;
      const track = this.room?.localParticipant.getTrackPublication(LK.Track.Source.Microphone)?.track;
      if (!track || track.getProcessor?.()) return;
      try {
        await Denoise.load();
        track.setAudioContext(Denoise.ctx);
        let handle = null;
        await track.setProcessor({
          name: 'rnnoise',
          processedTrack: undefined,
          async init(opts) { handle = await Denoise.process(opts.track); this.processedTrack = handle.track; },
          async restart(opts) { handle?.stop(); await this.init(opts); },
          async destroy() { handle?.stop(); handle = null; },
        });
      } catch (err) {
        console.warn('Supressão de ruído por IA indisponível:', err);
      }
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

    async startShare(opts) {
      const LK = window.LivekitClient;
      const p = shareProfile(opts);
      const pub = await this.room.localParticipant.setScreenShareEnabled(true, {
        audio: opts.audio,
        systemAudio: opts.audio ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude',
        contentHint: p.motion ? 'motion' : 'detail',
        resolution: { width: p.width, height: p.height, frameRate: p.fps },
      }, {
        screenShareEncoding: { maxBitrate: p.bitrate, maxFramerate: p.fps },
        // H.264 costuma ter codificação pela placa de vídeo: menos CPU (e menos atraso) em 1080p60
        videoCodec: 'h264',
        // Camada extra em 720p: quem tem internet fraca (ou vê a tela pequena) recebe essa, os outros recebem a qualidade cheia
        simulcast: true,
        screenShareSimulcastLayers: [new LK.VideoPreset(1280, 720, p.motion ? 1_500_000 : 1_000_000, p.motion ? 30 : 15)],
        degradationPreference: p.motion ? 'maintain-framerate' : 'maintain-resolution',
      });
      if (!pub?.track) throw Object.assign(new Error('cancelado'), { name: 'NotAllowedError' });
      this.localScreen = new MediaStream([pub.track.mediaStreamTrack]);
      return this.localScreen.id;
    }

    stopShare() {
      if (!this.localScreen) return;
      this.localScreen = null;
      this.room?.localParticipant.setScreenShareEnabled(false).catch(() => {});
    }

    async startCamera({ deviceId } = {}) {
      const pub = await this.room.localParticipant.setCameraEnabled(true, {
        deviceId: deviceId || undefined,
        resolution: { width: 1280, height: 720, frameRate: 30 },
      }, { simulcast: true, videoCodec: 'vp8' });
      if (!pub?.track) throw Object.assign(new Error('cancelado'), { name: 'NotAllowedError' });
      this.localCamera = new MediaStream([pub.track.mediaStreamTrack]);
      return this.localCamera.id;
    }

    stopCamera() {
      if (!this.localCamera) return;
      this.localCamera = null;
      this.room?.localParticipant.setCameraEnabled(false).catch(() => {});
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

  window.StraightTalkMedia = { P2PEngine, LiveKitEngine, watchLevel, noiseMode, Denoise };
})();
