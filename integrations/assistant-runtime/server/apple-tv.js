import {enabled} from './features.js';
import {randomUUID} from 'node:crypto';

export const appleTvEntities = config => new Set([config?.appleTv?.mediaPlayer, config?.appleTv?.remoteEntity].filter(value => typeof value === 'string' && value));

/** Uses HA's existing authenticated ingress. Never falls back to direct services. */
export class AppleTvController {
  constructor({ha, getConfig = () => ha.getConfig?.() || {}, fetchImpl = fetch, onProgress = () => {}, onFinished = () => {}, pollMs = 1500}) {
    Object.assign(this, {ha, getConfig, fetch: fetchImpl, onProgress, onFinished, pollMs});
    this.access = null;
    this.connecting = null;
    this.monitors = new Map();
  }

  async connect() {
    const cfg=this.getConfig();
    if(cfg.integrations && !enabled(cfg,'apple-tv'))throw Error('Apple TV integration is disabled.');
    if(cfg.appleTv?.baseUrl){const url=new URL(cfg.appleTv.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid Apple TV controller URL');return {url:url.toString().replace(/\/$/,''),path:'',authorization:cfg.appleTv.token?`Bearer ${cfg.appleTv.token}`:''};}
    const slug=cfg.appleTv?.addonSlug;
    if(typeof slug!=='string' || !/^[a-z0-9_]+$/.test(slug))throw Error('Configure the Apple TV controller URL or Home Assistant add-on slug.');
    if (this.access && this.access.url === this.ha.url && this.access.token === this.ha.token && Date.now() < this.access.expires) return this.access;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const info = await this.ha.send({type:'supervisor/api', endpoint:`/addons/${slug}/info`, method:'get'});
      if (info.state !== 'started' || !/^\/api\/hassio_ingress\/[^/]+\/$/.test(info.ingress_url || '')) throw Error('Apple TV AI is unavailable. Open its Home Assistant page to check it.');
      const session = await this.ha.send({type:'supervisor/api', endpoint:'/ingress/session', method:'post'});
      if (!session.session) throw Error('Home Assistant did not authorize Apple TV AI access.');
      this.access = {url:this.ha.url, token:this.ha.token, path:info.ingress_url.replace(/\/$/,''), cookie:`ingress_session=${session.session}`, expires:Date.now()+5*60_000};
      return this.access;
    })().finally(() => {this.connecting = null;});
    return this.connecting;
  }

  async request(path, body, {image = false} = {}) {
    let access;
    try {access = await this.connect();}
    catch {throw Error('Cannot reach Apple TV AI through Home Assistant. No direct remote fallback was used.');}
    let response;
    try {
      response = await this.fetch(new URL(access.path + path, access.url), {
        method:body === undefined ? 'GET' : 'POST', redirect:'error',
        headers:{...(access.cookie?{Cookie:access.cookie}:{}),...(access.authorization?{Authorization:access.authorization}:{}),'Content-Type':'application/json', 'X-TV-Controller':'1'},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(30000),
      });
    } catch {
      throw Error('Apple TV AI connection failed. The command may have arrived; check its status before retrying.');
    }
    if ([401,403,404,502,503].includes(response.status)) this.access = null;
    if (response.status === 409) throw Error('Apple TV AI is busy or this task has changed. Check its status; use context updates to correct a running task. No update or new task was applied by this request.');
    if (!response.ok) throw Error(`Apple TV AI rejected the request (${response.status}). No direct remote fallback was used.`);
    if(image){
      if(!response.headers.get('content-type')?.startsWith('image/'))throw Error('TV preview is unavailable.');
      const bytes=Buffer.from(await response.arrayBuffer());
      if(bytes.length>6*1024*1024)throw Error('TV preview is too large.');
      return bytes;
    }
    try {return await response.json();} catch {throw Error('Apple TV AI returned an unreadable result. Check status before retrying.');}
  }

  async frame() {return this.request('/api/frame',undefined,{image:true});}

  async command(domain, service, data) {
    const {entity_id, ...args} = data;
    if (!appleTvEntities(this.getConfig()).has(entity_id) || domain !== entity_id.split('.')[0]) throw Error('Unsupported Apple TV target');
    const run = await this.request('/api/command', {request_id:randomUUID(), entity_id, service, data:args});
    if (run.status !== 'completed') throw Error('Apple TV AI did not confirm the command. Check task status before retrying.');
    return {source:'apple_tv_ai', id:run.id, status:run.status, verified:false};
  }

  async start(goal, ctx = {}) {
    const context = String(this.getConfig().appleTv?.context || '').trim().slice(0,6000);
    const scopedGoal = context ? `${goal}\n\nOwner-provided TV context:\n${context}` : goal;
    const run = await this.request('/api/start', {goal:scopedGoal, request_id:randomUUID()});
    this.monitor(run.id, ctx);
    return {success:true, source:'apple_tv_ai', id:run.id, status:run.status,
      message:'Apple TV AI has started the task. This is not completion; the final result will arrive separately.'};
  }

  async status(id) {
    const state = await this.request('/api/status');
    const run = !id || state.run?.id === id ? state.run : state.history?.find(item => item.id === id);
    if (!run && !id) return {id:null,status:'idle',goal:'',message:'No TV task is running.',model:state.model};
    if (!run) throw Error('That Apple TV task is no longer in the controller history.');
    return {...run, model:state.model};
  }

  async addContext(id, context, ctx = {}) {
    const run=await this.request('/api/context',{task_id:id,update_id:randomUUID(),context});
    this.monitor(run.id,ctx);
    return {success:true,source:'apple_tv_ai',...run,applied:run.applied_context_revision>=run.context_revision,
      message:'Context received for the same task. It will be used at the next decision; no task was restarted.'};
  }

  async stop(id) {
    const run = await this.request('/api/stop', {request_id:id});
    return {success:true, source:'apple_tv_ai', id:run.id, status:run.status, message:run.message};
  }

  monitor(id, ctx) {
    if (this.monitors.has(id)) return;
    const started = Date.now(); let previous = '', failures = 0;
    const poll = async () => {
      try {
        const run = await this.status(id); failures = 0;
        const signature = `${run.status}:${run.steps}:${run.events?.length || 0}:${run.context_revision || 0}:${run.applied_context_revision || 0}`;
        if (signature !== previous) {previous=signature;this.onProgress(run, ctx);}
        if (run.status !== 'running') {this.monitors.delete(id);this.onFinished(run, ctx);return;}
      } catch {
        failures++;
      }
      if (failures >= 5 || Date.now()-started > 16*60_000) {
        this.monitors.delete(id);
        const run={id,status:'unconfirmed',message:'I lost contact with Apple TV AI. Its task may still be running; ask me for its status before trying again.'};
        this.onProgress(run,ctx);this.onFinished(run,ctx);return;
      }
      const timer=setTimeout(poll,this.pollMs);timer.unref?.();this.monitors.set(id,timer);
    };
    const timer=setTimeout(poll,this.pollMs);timer.unref?.();this.monitors.set(id,timer);
  }
}
