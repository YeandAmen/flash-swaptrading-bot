const ALCHEMY_ETHEREUM_HOST = 'eth-mainnet.g.alchemy.com';
const SUBSCRIBE = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] });

interface HeadWake {
  wait(ms: number): Promise<void>;
  stop(): void;
}

interface HeadMessage {
  id?: unknown;
  result?: unknown;
  method?: unknown;
  params?: { subscription?: unknown; result?: { hash?: unknown } };
}

/** Use WebSocket notifications as wake hints. All head reads and checks still use HTTP. */
export function createHeadWake(rpcUrl: string): HeadWake | null {
  if (typeof WebSocket === 'undefined') return null;
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== ALCHEMY_ETHEREUM_HOST || url.port
    || url.username || url.password || url.search || url.hash || !/^\/v2\/[\w-]+$/.test(url.pathname)) return null;
  url.protocol = 'wss:';

  let socket: WebSocket | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let delayMs = 1_000;
  let stopped = false;
  let buffered = false;
  let lastHash: string | undefined;
  const waiters = new Set<() => void>();

  function notify() {
    buffered = waiters.size === 0;
    for (const wake of waiters) wake();
  }

  function retry() {
    if (stopped || reconnect) return;
    reconnect = setTimeout(() => {
      reconnect = undefined;
      connect();
    }, delayMs);
    reconnect.unref();
    delayMs = Math.min(delayMs * 2, 60_000);
  }

  function connect() {
    let stream: WebSocket;
    try {
      stream = new WebSocket(url.href);
    } catch {
      retry();
      return;
    }
    socket = stream;
    let subscription: string | undefined;
    function resetTimeout(ms: number) {
      clearTimeout(timeout);
      timeout = setTimeout(() => stream.close(), ms);
      timeout.unref();
    }

    resetTimeout(8_000);
    stream.addEventListener('open', () => {
      if (!stopped) stream.send(SUBSCRIBE);
    }, { once: true });
    stream.addEventListener('error', () => stream.close(), { once: true });
    stream.addEventListener('close', () => {
      clearTimeout(timeout);
      socket = undefined;
      retry();
    }, { once: true });
    stream.addEventListener('message', ({ data }) => {
      if (stopped || typeof data !== 'string') return;
      let msg: HeadMessage | null;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg?.id === 1 && typeof msg.result === 'string') {
        subscription = msg.result;
        delayMs = 1_000;
        resetTimeout(45_000);
      }
      if (msg?.method !== 'eth_subscription' || !subscription || msg.params?.subscription !== subscription) return;
      const hash = msg.params.result?.hash;
      if (typeof hash !== 'string' || !/^0x[\da-f]{64}$/i.test(hash)) return;
      resetTimeout(45_000);
      if (hash === lastHash) return;
      lastHash = hash;
      notify();
    });
  }

  connect();
  return {
    wait(ms) {
      if (stopped || buffered) {
        buffered = false;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, ms);
        waiters.add(wake);
      });
    },
    stop() {
      stopped = true;
      clearTimeout(reconnect);
      clearTimeout(timeout);
      socket?.close();
      for (const wake of waiters) wake();
    },
  };
}
