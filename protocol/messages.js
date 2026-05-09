(function initFiledropProtocol(globalScope) {
  const TYPES = Object.freeze({
    FILE_META: 'file-meta',
    TRANSFER_ACCEPTED: 'transfer-accepted',
    TRANSFER_REJECTED: 'transfer-rejected',
    CHAT: 'chat'
  });

  function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function sanitizeRoomCode(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toUpperCase();
  }

  function isSafeText(value, maxLength) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
  }

  function isFileMetaMessage(payload) {
    return isObject(payload)
      && payload.type === TYPES.FILE_META
      && isSafeText(payload.name, 512)
      && Number.isFinite(payload.size)
      && payload.size > 0;
  }

  function isTransferAcceptedMessage(payload) {
    return isObject(payload) && payload.type === TYPES.TRANSFER_ACCEPTED;
  }

  function isTransferRejectedMessage(payload) {
    return isObject(payload) && payload.type === TYPES.TRANSFER_REJECTED;
  }

  function isChatMessage(payload) {
    return isObject(payload)
      && payload.type === TYPES.CHAT
      && typeof payload.text === 'string'
      && payload.text.length > 0
      && payload.text.length <= 2000;
  }

  function parseJsonMessage(data) {
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    }

    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
      try {
        const text = new TextDecoder().decode(data);
        return JSON.parse(text);
      } catch {
        return null;
      }
    }

    try {
      return JSON.parse(data.toString());
    } catch {
      return null;
    }
  }

  function buildRtcConfigFromEnv(env) {
    const stunServers = (env.FILEDROP_STUN_SERVERS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    const turnUrls = (env.FILEDROP_TURN_URLS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    const iceServers = [];
    for (const urls of stunServers) iceServers.push({ urls });

    if (turnUrls.length > 0 && env.FILEDROP_TURN_USERNAME && env.FILEDROP_TURN_CREDENTIAL) {
      iceServers.push({
        urls: turnUrls,
        username: env.FILEDROP_TURN_USERNAME,
        credential: env.FILEDROP_TURN_CREDENTIAL
      });
    }

    if (iceServers.length === 0) {
      iceServers.push(
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      );
    }

    return {
      iceServers,
      iceCandidatePoolSize: 10
    };
  }

  const protocol = {
    TYPES,
    sanitizeRoomCode,
    parseJsonMessage,
    isFileMetaMessage,
    isTransferAcceptedMessage,
    isTransferRejectedMessage,
    isChatMessage,
    buildRtcConfigFromEnv
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = protocol;
  }
  globalScope.FiledropProtocol = protocol;
})(typeof window !== 'undefined' ? window : globalThis);
