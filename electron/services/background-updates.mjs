const HOUR = 60 * 60 * 1000;

/** 仅在后台检查和下载；安装始终由用户明确确认。 */
export class BackgroundUpdates {
  #updater;
  #download;
  #now;
  #timer;
  #last = null;
  #next = 0;
  #running = null;
  #stopped = true;
  constructor({ updater, autoDownload = () => true, now = Date.now }) {
    this.#updater = updater;
    this.#download = autoDownload;
    this.#now = now;
  }
  tick() {
    if (this.#stopped || !this.#updater.supported || this.#now() < this.#next)
      return Promise.resolve(false);
    if (this.#running) return this.#running;
    if (
      ["checking", "downloading", "downloaded", "installing"].includes(this.#updater.status().state)
    )
      return Promise.resolve(false);
    this.#last = this.#now();
    this.#next = this.#last + 4 * HOUR;
    this.#running = (async () => {
      try {
        const state = await this.#updater.check();
        if (state.state === "error") this.#next = this.#last + HOUR / 4;
        if (!this.#stopped && state.state === "outdated" && !state.manual && this.#download()) {
          const downloaded = await this.#updater.download();
          if (downloaded.state === "error") this.#next = this.#last + HOUR / 4;
        }
        return true;
      } catch {
        this.#next = this.#last + HOUR / 4;
        return false;
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }
  start({ firstDelay = 30_000, every = 60_000 } = {}) {
    this.stop();
    this.#stopped = false;
    this.#next = Math.max(this.#next, this.#now() + firstDelay);
    const initial = setTimeout(() => {
      this.#timer = setInterval(() => void this.tick(), every);
      this.#timer.unref?.();
      void this.tick();
    }, firstDelay);
    initial.unref?.();
    this.#timer = initial;
  }
  stop() {
    this.#stopped = true;
    clearTimeout(this.#timer);
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
