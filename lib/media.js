// Configuração de mídia (voz e tela).
//
// Dois modos:
//  - "livekit": voz e tela passam por um servidor de mídia LiveKit (SFU). Aguenta salas
//    grandes e já traz TURN embutido. Ativado quando LIVEKIT_URL/API_KEY/API_SECRET existem.
//  - "p2p": cada pessoa manda direto para cada outra (malha). Menor delay possível, bom para
//    até ~6 pessoas. Usa STUN e, se configurado, um servidor TURN (coturn) para redes fechadas.
const crypto = require('crypto');

const env = process.env;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function livekitEnabled() {
  return !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
}

// Token de acesso do LiveKit (JWT HS256), sem depender do SDK.
function livekitToken({ identity, name, room, ttlSeconds = 6 * 3600 }) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: env.LIVEKIT_API_KEY,
    sub: identity,
    name,
    nbf: now - 10,
    exp: now + ttlSeconds,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac('sha256', env.LIVEKIT_API_SECRET).update(data).digest();
  return `${data}.${b64url(sig)}`;
}

// Servidores ICE para o modo P2P.
// TURN_URLS="turn:meu.servidor:3478,turns:meu.servidor:5349"
// Credenciais: TURN_SECRET (coturn com use-auth-secret, credenciais temporárias)
//          ou TURN_USERNAME + TURN_PASSWORD (fixas).
function iceServers(userId) {
  const list = [{ urls: (env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',') }];
  if (env.TURN_URLS) {
    const urls = env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean);
    if (env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 12 * 3600}:${userId}`;
      const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
      list.push({ urls, username, credential });
    } else if (env.TURN_USERNAME) {
      list.push({ urls, username: env.TURN_USERNAME, credential: env.TURN_PASSWORD || '' });
    }
  }
  return list;
}

function clientConfig(userId) {
  return livekitEnabled()
    ? { mode: 'livekit', livekitUrl: env.LIVEKIT_URL }
    : { mode: 'p2p', iceServers: iceServers(userId) };
}

module.exports = { livekitEnabled, livekitToken, iceServers, clientConfig };
