import { randomUUID } from 'node:crypto';

/** One authenticated phone receiver; completion means its TTS end event arrived. */
export class PhoneSpeaker {
  constructor({ now = Date.now, timeoutMs = 90_000 } = {}) {
    this.now = now; this.timeoutMs = timeoutMs;
    this.clientId = ''; this.seenAt = 0; this.job = null; this.waiters = new Set();
  }
  state() { return { ready: Boolean(this.clientId && this.now() - this.seenAt < 35_000), pending: Boolean(this.job) }; }
  touch(clientId, ready) {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(clientId)) throw new Error('invalid phone client');
    if (!ready) {
      if (this.clientId === clientId) { this.clientId = ''; this.finish(false, 'Phone audio was disabled'); }
      return false;
    }
    if ((this.state().ready && this.clientId !== clientId) || (this.job && this.job.clientId !== clientId)) return false;
    this.clientId = clientId; this.seenAt = this.now(); return true;
  }
  async poll(clientId, ready, wait = true) {
    const owns = this.touch(clientId, ready);
    if (owns && !this.job && wait) await new Promise(resolve => {
      const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, 20_000); timer.unref?.(); this.waiters.add(wake);
    });
    return owns && this.clientId === clientId && this.job ? {id:this.job.id, text:this.job.text} : null;
  }
  speak(text) {
    if (!this.state().ready) return Promise.resolve({success:false,error:'Enable phone audio on the iPhone Carvis screen first'});
    if (this.job) return Promise.resolve({success:false,error:'Phone speaker is busy'});
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => this.finish(false, 'Phone did not confirm playback'), this.timeoutMs); timer.unref?.();
      this.job = {id, text, resolve, timer, clientId:this.clientId};
      for (const wake of [...this.waiters]) wake();
    });
  }
  acknowledge(clientId, id, success) {
    if (!this.job || this.job.id !== id || this.job.clientId !== clientId) return false;
    this.seenAt = this.now(); this.finish(success, 'Phone speech playback failed'); return true;
  }
  finish(success, error) {
    if (!this.job) return;
    const job = this.job; this.job = null; clearTimeout(job.timer);
    job.resolve(success ? {success:true,target:'iphone',streamFinished:true} : {success:false,error});
  }
}
