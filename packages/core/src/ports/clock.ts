/**
 * Motor asla `Date.now()` ya da `setTimeout` çağırmaz. Zaman enjekte edilir;
 * böylece 4 saatlik bir cooldown testi milisaniyede koşar ve testler duvar
 * saatine bağlı olarak titremez.
 */
export interface Clock {
  now(): number;
}

export interface Sleeper {
  /**
   * `signal` iptal edilirse hata fırlatmadan erken döner — döngü bir sonraki
   * turda durumu zaten yeniden değerlendirecek, istisna gürültüsüne gerek yok.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = { now: () => Date.now() };

export const systemSleeper: Sleeper = {
  sleep(ms, signal) {
    if (ms <= 0 || signal?.aborted === true) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      function finish() {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      }
      signal?.addEventListener('abort', finish, { once: true });
    });
  },
};
