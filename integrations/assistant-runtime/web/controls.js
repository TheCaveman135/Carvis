/** Native Integration panels. All effects use the existing authenticated APIs. */
const base = '/integrations/assistant-engine';
const list = value => Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value) : [];
const words = value => String(value ?? '').replaceAll('_', ' ');
const time = value => value ? new Date(value).toLocaleString() : 'Not yet';
export async function mount(ui) {
  const {root,integration,section,el,button,input,field,api,signal,navigate} = ui;
  let dispose = () => {}, generation = 0, routineTab = 'Routines';
  const feedback = el('div', {class:'control-feedback',role:'status','aria-live':'polite'});
  const content = el('div', {class:'native-controls'});
  const get = path => api(base+path,{signal});
  const post = (path,body) => api(base+path,{method:'POST',body,signal});
  const note = (message,error=false) => feedback.replaceChildren(el('div',{class:`notice${error?' error':''}`},message));
  const action = (label,fn,style='compact') => button(label,async event=>{
    const control=event?.currentTarget; if(control){control.disabled=true;control.dataset.pending='true';}
    try { const result=await fn(); if(result?.ok===false || result?.success===false) throw Error(result.error || result.message || 'The action could not be completed.'); }
    catch(error){if(!signal.aborted)note(error.message,true);}
    finally{if(control){delete control.dataset.pending;control.disabled=control.dataset.locked==='true';}}
  },style);
  const card = (title,description,...children) => el('section',{class:'control-card'},el('h2',{},title),description?el('p',{class:'muted'},description):null,...children);
  const details = (label,data) => el('details',{class:'control-details'},el('summary',{},label),el('pre',{},JSON.stringify(data,null,2)));
  const empty = text => el('p',{class:'control-empty'},text);
  const row = (title,description,...actions) => el('article',{class:'control-row'},el('div',{},el('strong',{},title),description?el('p',{},description):null),el('div',{class:'action-row'},...actions));
  const select = (name,options,value) => el('select',{name},options.map(([v,label])=>el('option',{value:v,selected:String(v)===String(value)},label)));
  const submitForm = (fields,label,handler) => {
    const submit=el('button',{class:'button primary compact',type:'submit'},label);
    const form=el('form',{class:'control-form'},fields,submit);
    form.addEventListener('submit',async event=>{event.preventDefault();if(!form.reportValidity())return;submit.disabled=true;submit.dataset.pending='true';try{await handler();}catch(error){if(!signal.aborted)note(error.message,true);}finally{delete submit.dataset.pending;submit.disabled=submit.dataset.locked==='true';}});
    return form;
  };
  async function result(value) {
    if(value?.ok===false || value?.success===false) throw Error(value.error || value.message || 'The request failed. Check Activity before retrying.');
    note(value.reply || value.message || (value.dry_run || value.dryRun ? 'Dry run: no device command was sent.' : 'Request accepted. Check the result below.'));
    if(value.confirmation) {
      const pending=value.confirmation;
      feedback.append(el('div',{class:'confirmation-card'},el('p',{},pending.prompt || pending.summary || 'This action requires your confirmation.'),
        action('Approve',async()=>result(await post('/api/glasses/confirmation',{id:pending.id,accepted:true}))),
        action('Decline',async()=>result(await post('/api/glasses/confirmation',{id:pending.id,accepted:false})))));
    } else if(value.requires_confirmation || value.requiresConfirmation) {
      note('This action requires an owner confirmation. Ask Carvis in chat to confirm it; no action has been authorized here.');
    }
    return value;
  }
  async function tool(name,args={}) { return result(await post('/api/carvis/tool',{tool:name,arguments:args})); }
  function askForm(label,placeholder,prefix='') {
    const text=el('textarea',{rows:3,required:true,placeholder,'aria-label':label});
    return submitForm([field(label,text)],'Send to Carvis',async()=>{await result(await post('/api/carvis/request',{text:prefix+text.value}));text.value='';});
  }
  function records(items,render,emptyText='Nothing here yet.') { return items.length ? items.map(render) : empty(emptyText); }
  function activity(snapshot) {
    const traces=list(snapshot.trace?.invocations || snapshot.trace?.turns || snapshot.trace);
    return card('Execution traces','See what Carvis heard, what ran, and what actually happened.',records(traces,item=>el('article',{class:'trace-native'},
      el('h3',{},words(item.outcome || item.status || item.triggerType || 'Assistant request')),
      el('p',{},`${time(item.startedAt || item.started_at || item.ts || item.createdAt)}${item.durationMs!==undefined?' · '+item.durationMs+' ms':''}`),
      item.trigger?.transcript ? el('blockquote',{},item.trigger.transcript) : null,
      records(list(item.toolCalls || item.calls || item.tools),call=>row(call.tool || call.name || 'Action',call.outcome || call.status || call.diagnostic || 'Recorded')),
      details('Full execution details',item))));
  }
  async function reload() {
    const current=++generation;dispose();dispose=()=>{};
    const snapshot=await get('/api/state');
    if(signal.aborted || current!==generation)return;
    content.replaceChildren();
    if(section==='activity') {
      if(integration.id==='voice') transcript(snapshot);
      else if(integration.id==='protocols') content.append(card('Recent routine runs','Completed and failed runs, without replaying any actions.',records(list(snapshot.automations?.recentRuns),r=>row(r.name || r.rule_id || 'Routine',`${words(r.status)} · ${time(r.ts || r.started_at)}`,details('Details',r)))));
      else if(integration.id==='speech') content.append(card('Speech delivery','Recent output, retries, and delivery state.',details('Delivery state',snapshot.speechOutput),details('Phone connection',snapshot.phoneSpeaker)));
      else content.append(activity(snapshot));
      return;
    }
    switch(integration.id) {
      case 'apple-tv': await tv(snapshot); break;
      case 'protocols': await protocols(snapshot); break;
      case 'learned-memory': await memories(); break;
      case 'cameras': cameras(snapshot); break;
      case 'voice': await voice(snapshot); break;
      case 'even-realities': glasses(snapshot); break;
      case 'home-assistant': home(snapshot); break;
      case 'speech': speech(snapshot); break;
      case 'proactivity': proactive(snapshot); break;
      case 'physical-carvis': physical(snapshot); break;
      case 'atlas': atlas(snapshot); break;
      case 'desktop': desktop(snapshot); break;
      case 'web-search': content.append(card('Ask about current information','Search is available directly in chat.',askForm('What would you like to look up?','For example: What changed in this week’s technology news?','Search the web for: '))); break;
      default: content.append(card('Assistant activity','Manage voice, memory, routines, and devices from their own integration pages.',el('div',{class:'control-links'},ui.integrations.filter(i=>i.id!=='assistant-engine' && i.enabled).map(i=>el('a',{href:`#integrations/${i.id}/controls`,class:'button compact'},i.name)))),activity(snapshot));
    }
  }
  function transcript(snapshot) {
    content.append(card('What Carvis heard','Review transcription and routing decisions.',records(list(snapshot.transcript?.entries || snapshot.transcript),item=>el('article',{class:'control-row'},el('div',{},el('strong',{},item.text || item.transcript || item.raw || 'Audio received'),el('p',{},`${words(item.decision || item.status || item.stage)} · ${time(item.ts || item.at)}`),details('Transcription details',item))))));
  }
  async function tv() {
    let run, polling=false;
    try{run=await get('/api/tv/status');}catch(error){content.append(card('TV controller',error.message));return;}
    const image=el('img',{class:'tv-frame',alt:'Current Apple TV screen',src:base+'/api/tv/frame?t='+Date.now()});
    const refresh=action('Refresh screen',async()=>{image.hidden=false;image.src=base+'/api/tv/frame?t='+Date.now();});
    image.addEventListener('error',()=>{image.hidden=true;refresh.textContent='Retry screen preview';});
    const taskGoal=el('p'),taskStatus=el('p',{role:'status'}),taskMessage=el('p');
    const goal=el('textarea',{required:true,rows:3,placeholder:'Find a film, open an app, or describe a task.'});
    const context=el('textarea',{required:true,rows:2,placeholder:'For example: Try Netflix instead of Prime.'});
    const start=submitForm([field('What should the TV do?',goal)],'Start TV task',async()=>{await tool('ha.apple_tv.task',{goal:goal.value});await poll();});
    const guidance=submitForm([field('Add guidance to the current task',context)],'Add context',async()=>{await tool('ha.apple_tv.context',{id:run.id,context:context.value});context.value='';await poll();});
    const stop=action('Stop task',async()=>{await tool('ha.apple_tv.stop',{id:run.id});await poll();});
    const progress=el('pre');
    const remoteButtons=[['↑','up'],['←','left'],['Select','select'],['→','right'],['↓','down'],['Back','menu'],['Home','top_menu']].map(([label,command])=>{
      const b=action(label,async()=>result(await post('/api/carvis/request',{text:`Press ${command} on the Apple TV.`})));b.setAttribute('aria-label',`TV ${command}`);return b;
    });
    const playback=['Turn on','Turn off','Play','Pause'].map(label=>action(label,async()=>result(await post('/api/carvis/request',{text:`${label} the Apple TV.`}))));
    function update(next){
      run=next.run || next.task || next;const running=run.status==='running';
      taskGoal.textContent=run.goal || 'No task is running.';taskStatus.textContent=`Status: ${words(run.status || 'idle')}`;taskMessage.textContent=run.message || '';
      progress.textContent=JSON.stringify(run,null,2);const lock=(control,locked)=>{control.dataset.locked=String(locked);control.disabled=locked || control.dataset.pending==='true';};
      lock(start.querySelector('button[type=submit]'),running);lock(guidance.querySelector('button[type=submit]'),!running);lock(stop,!running);
      for(const control of [...remoteButtons,...playback])lock(control,running);
    }
    async function poll(){if(polling || signal.aborted)return;polling=true;try{const next=await get('/api/tv/status');if(!signal.aborted)update(next);}catch(error){if(!signal.aborted){taskStatus.textContent='Connection lost. Refresh before sending another command.';for(const control of [...remoteButtons,...playback,...start.querySelectorAll('button'),...guidance.querySelectorAll('button'),stop]){control.dataset.locked='true';control.disabled=true;}}}finally{polling=false;}}
    update(run);
    content.append(el('div',{class:'control-two-column'},card('TV screen','Refresh the preview to see the current screen.',image,refresh),card('Current task','Progress refreshes automatically without clearing what you are typing.',taskGoal,taskStatus,taskMessage,stop,start,guidance,el('details',{class:'control-details'},el('summary',{},'Task progress'),progress))));
    content.append(card('Remote','Every button goes through Apple TV AI in Home Assistant.',el('div',{class:'tv-remote'},remoteButtons),el('div',{class:'action-row'},playback),el('p',{class:'small muted'},'Change navigation silence and playback replies in Settings → Reply behavior.')));
    const timer=setInterval(poll,3000);dispose=()=>clearInterval(timer);
  }
  async function protocols(snapshot) {
    const state=snapshot.automations || await get('/api/automations');
    const tabs=el('div',{class:'control-subnav',role:'tablist','aria-label':'Routine types'}),area=el('div');
    const show=(name)=>{
      routineTab=name;
      tabs.querySelectorAll('button').forEach(b=>{const on=b.textContent===name;b.classList.toggle('active',on);b.setAttribute('aria-selected',String(on));});area.replaceChildren();
      if(name==='Routines') {
        area.append(card('Create a routine','Describe when it should happen and what Carvis should do. Carvis will validate the trigger and actions.',askForm('Routine description','For example: When the printer finishes, turn on the desk light.','Create a protocol: ')));
        const rules=list(state.rules?.items || state.rules);
        area.append(card('Saved routines','Review or edit a routine before enabling it.',records(rules,r=>row(r.name || r.id,`${r.enabled?'Enabled':'Disabled'}${r.description?' · '+r.description:''}`,
          action(r.enabled?'Disable':'Enable',async()=>{await post('/api/automations/toggle',{id:r.id,enabled:!r.enabled});await reload();}),
          action('Edit',()=>editRule(r.id,area)),action('History',async()=>{const h=await post('/api/automations/history',{id:r.id,limit:20});area.append(card('Run history',r.name,records(list(h.runs),run=>row(words(run.status),time(run.ts || run.started_at),details('Details',run)))));}),
          action('Run now',async()=>{await result(await post('/api/automations/run',{id:r.id}));await reload();}),
          action('Duplicate',async()=>{await post('/api/automations/duplicate',{id:r.id});await reload();}),
          action('Archive',async()=>{if(window.confirm('Archive this routine? It will stop running.')){await post('/api/automations/archive',{id:r.id});await reload();}})))));
      } else if(name==='Timers' || name==='Alarms') {
        const alarm=name==='Alarms',nameInput=input('name','','text',{required:true,placeholder:alarm?'Wake-up alarm':'Kitchen timer'}),duration=input('duration','','text',{required:true,placeholder:alarm?'07:30':'20 minutes'}),speak=input('speak','','checkbox',{checked:true});
        const repeat=select('repeat',[['none','Once'],['daily','Every day'],['weekdays','Weekdays']],'none');
        area.append(card(alarm?'Add an alarm':'Start a timer',alarm?'Uses the Carvis server’s local timezone.':'Timers survive a Carvis restart.',submitForm([field('Name',nameInput),field(alarm?'Time':'Duration',duration),alarm?field('Repeat',repeat):null,field('Read the reminder aloud',speak)],alarm?'Create alarm':'Start timer',async()=>{await tool(alarm?'alarm.create':'timer.start',{name:nameInput.value,...(alarm?{at:duration.value,repeat:repeat.value}:{duration:duration.value}),speak:speak.checked});await reload();})));
        const items=list(alarm?state.alarms:state.timers);
        area.append(card(alarm?'Your alarms':'Your timers','',records(items,t=>row(t.name,`${words(t.state || t.status)} · ${t.dueAt || t.due_at ? time(t.dueAt || t.due_at) : 'No due time'}`,
          !alarm?action(t.status==='paused'?'Resume':'Pause',async()=>{await tool(t.status==='paused'?'timer.resume':'timer.pause',{id:t.id});await reload();}):action('Snooze 5 min',async()=>{await tool('alarm.snooze',{id:t.id,seconds:300});await reload();}),
          action('Cancel',async()=>{await tool(alarm?'alarm.cancel':'timer.cancel',{id:t.id});await reload();})))));
      } else {
        const nameInput=input('name','','text',{required:true}),value=input('value','','text',{required:true});
        area.append(card('Saved values','Named values used by your routines.',records(list(state.variables),v=>row(v.name,typeof v.value==='object'?JSON.stringify(v.value):String(v.value),action('Remove',async()=>{await tool('variable.unset',{name:v.name});await reload();}))),submitForm([field('Name',nameInput),field('Value',value)],'Save value',async()=>{await tool('variable.set',{name:nameInput.value,value:value.value});await reload();})));
      }
    };
    for(const name of ['Routines','Timers','Alarms','Saved values'])tabs.append(el('button',{type:'button',class:'button quiet compact',role:'tab',onclick:()=>show(name)},name));
    content.append(tabs,area);show(routineTab);
  }
  async function editRule(id,area) {
    const {rule}=await post('/api/automations/get',{id});
    const definition=rule.definition || Object.fromEntries(Object.entries(rule).filter(([key])=>!['revision','archived','createdAt','updatedAt','createdBy','lastEvaluatedAt','lastFiredAt','fireCount','whileIterations','lastMatch','lastOutcome','lastError','summary'].includes(key)));
    const name=input('rule-name',definition.name || '', 'text',{required:true}),description=el('textarea',{rows:2},definition.description || '');
    const enabled=input('rule-enabled','','checkbox',{checked:!!definition.enabled});
    const json=el('textarea',{rows:14,class:'json-input','aria-label':'Advanced routine definition'},JSON.stringify(definition,null,2));
    const data=()=>({...JSON.parse(json.value),name:name.value,description:description.value,enabled:enabled.checked});
    const editor=card('Edit routine','Name and description are safe to edit here. Use the advanced definition for trigger, condition, and action changes.',submitForm([field('Name',name),field('Description',description),field('Enabled',enabled),el('details',{class:'advanced-settings'},el('summary',{},'Trigger, conditions & actions'),field('Routine definition',json,'The full validated definition. Revision checks protect against overwriting a newer edit.'))],'Save routine',async()=>{await post('/api/automations/save',{definition:data(),expectedRevision:rule.revision});await reload();}),action('Validate without running',async()=>{const checked=await post('/api/automations/validate',{definition:data()});note(checked.ok?'Routine is valid. No actions ran.':JSON.stringify(checked.errors));}));
    area.prepend(editor);editor.scrollIntoView({block:'start',behavior:'smooth'});
  }
  async function memories() {
    const state=await get('/api/memories');
    const text=el('textarea',{required:true,rows:3,placeholder:'Something useful for Carvis to remember.'}),kind=select('kind',[['fact','Fact'],['preference','Preference'],['rule','Owner rule']],'fact');
    content.append(card('Add a memory','Tell Carvis about a preference, fact, or rule.',submitForm([field('Memory',text),field('Type',kind)],'Remember this',async()=>{await post('/api/memories',{text:text.value,kind:kind.value});await reload();})),
      card('What Carvis remembers','Review, edit, or remove stored memories.',records(list(state.memories),m=>{
        const editor=el('textarea',{rows:2,'aria-label':'Memory text'},m.text),pinned=input('pinned','','checkbox',{checked:!!m.pinned});
        return el('article',{class:'control-card'},el('p',{class:'small muted'},`${words(m.kind)} · ${words(m.source || 'Carvis')}`),editor,field('Keep pinned',pinned),el('div',{class:'action-row'},action('Save',async()=>{await post('/api/memories/update',{id:m.id,text:editor.value,kind:m.kind,pinned:pinned.checked});await reload();}),action('Forget',async()=>{if(window.confirm('Remove this memory?')){await post('/api/memories/delete',{id:m.id});await reload();}})));
      })),card('Suggested patterns','Patterns are observations. They do not give Carvis permission to act.',records(list(state.patterns),p=>row(p.summary || p.text || p.description || p.id,p.status || '',details('Pattern evidence',p),action('Dismiss',async()=>{await post('/api/patterns/dismiss',{id:p.id});await reload();})))));
  }
  function cameras(snapshot) {
    const objective=el('textarea',{rows:3,required:true,placeholder:'What should Carvis look for? For example: Which room contains the blue suitcase?'});
    const file=input('image','','file',{accept:'image/jpeg,image/png,image/webp'});
    const selected=new Set(snapshot.config?.entities?.observed || []);
    const cameras=list(snapshot.entities).filter(e=>e.entity_id?.startsWith('camera.') && selected.has(e.entity_id));
    content.append(card('Inspect an image or your cameras','A focused question helps Carvis look for the right details.',el('p',{},cameras.length?`${cameras.length} selected camera${cameras.length===1?'':'s'} available.`:'No selected cameras. You can still upload an image.'),
      submitForm([field('Question or objective',objective),field('Optional image upload',file,'Up to 6 MB. Leave empty to use selected cameras.')],'Ask Carvis to look',async()=>{
        const ids=[];if(file.files[0]){if(file.files[0].size>6000000)throw Error('Choose an image smaller than 6 MB.');const response=await fetch(base+'/api/vision/image',{method:'POST',headers:{'Content-Type':file.files[0].type || 'application/octet-stream'},body:file.files[0],signal});const uploaded=await response.json();if(!response.ok)throw Error(uploaded.message || 'Upload failed.');ids.push(uploaded.id);}
        if(!ids.length&&!cameras.length)throw Error('Upload an image or select a Home Assistant camera first.');
        await result(await post('/api/carvis/request',{text:objective.value,image_ids:ids}));
      })),card('Room and object context','Add descriptions so Carvis recognizes furniture and rooms correctly.',el('a',{class:'button compact',href:'#integrations/home-assistant/settings'},'Edit room notes')));
  }
  async function voice(snapshot) {
    content.append(card('Voice input','Deepgram transcribes audio from your paired microphone device. Carvis processes the text using your normal assistant model.',el('p',{},'Use Spoken replies to choose where Carvis answers aloud.')));
    transcript(snapshot);
  }
  function home(snapshot) {
    const connected=snapshot.status?.ha?.status==='connected';
    content.append(card('Home Assistant connection',connected?'Connected to your home.':'Not connected. Check the address and access token in Settings.',el('a',{class:'button compact',href:'#integrations/home-assistant/settings'},'Devices & permissions'),action('Reconnect',async()=>{await post('/api/ha/reconnect',{});await reload();})),card('Ask about your home','Only selected devices are available to Carvis.',askForm('Request','For example: Which lights are on?')));
  }
  function speech(snapshot) {
    content.append(card('Speech output',snapshot.phoneSpeaker?.ready?'Your phone speaker is connected.':'Phone speaker is not currently connected.',el('p',{},`Output: ${words(snapshot.config?.speech?.outputMode || 'physical_then_ha')}`),askForm('Try a spoken reply','Say hello in one short sentence.')),card('Delivery status','Check whether speech reached its destination.',details('Latest delivery',snapshot.speechOutput)));
  }
  function proactive(snapshot) {
    content.append(card('Current activity','Carvis uses your selected Home Assistant events and interruption preferences.',row('Home Assistant',words(snapshot.status?.ha?.status || 'not connected')),details('Activity session',snapshot.session),details('Recent decisions',snapshot.classifier)),card('Recent home events','Read-only event history.',records(list(snapshot.events),event=>row(words(event.type),time(event.ts || event.at),details('Event details',event)))));
  }
  function glasses(snapshot) {
    content.append(card('Glasses display','Review the current widgets and clear them when you need a blank screen.',records(list(snapshot.hud?.slots).map((widget,index)=>widget?{...widget,slot:index+1}:null).filter(Boolean), (widget,index)=>row(`Widget ${widget.slot || index+1}`,widget.title || widget.text || words(widget.type),details('Widget details',widget))),action('Clear glasses screen',async()=>{await post('/api/hud/clear',{});await reload();})),card('Create or change a widget','Tell Carvis what you want to see or control.',askForm('Widget request','Show a light toggle and a brightness slider on my glasses.')),card('Connection status','Phone audio and display contact.',details('Glasses contact',snapshot.glassesDisplay),details('Phone speaker',snapshot.phoneSpeaker)));
  }
  function physical(snapshot) {
    content.append(card('Device status','Contact, queued commands, and acknowledgements from physical Carvis.',details('Current device state',snapshot.physicalCarvis)),card('Pair a device','Show the current pairing or generate a replacement. Keep the token private.',action('Show pairing details',async()=>{const pairing=await post('/api/physical-carvis/pair',{});feedback.replaceChildren(card('Device pairing','Copy these details into your device.',details('Pairing details',pairing)));}),action('Replace pairing token',async()=>{if(!window.confirm('Replace the pairing token? Existing devices will need the new token.'))return;const pairing=await post('/api/physical-carvis/pair',{regenerate:true});feedback.replaceChildren(card('New device pairing','Update your device with this private token.',details('Pairing details',pairing)));})));
  }

  function atlas(snapshot) {
    const title=input('title','','text'),text=el('textarea',{rows:4,required:true}),projectId=input('project','','text');
    content.append(card('Project connection','Refresh the project context shared with Carvis.',action('Refresh projects',async()=>{await result(await post('/api/atlas/refresh',{}));await reload();}),details('Project status',snapshot.atlas)),card('Capture a note','Save a note to Project Atlas.',submitForm([field('Title',title),field('Note',text),field('Project ID (optional)',projectId)],'Save note',async()=>{await result(await post('/api/atlas/capture',{title:title.value,text:text.value,projectId:projectId.value || undefined}));text.value='';})));
  }
  function desktop(snapshot) {
    const command=input('command','','text',{required:true,placeholder:'Describe the desktop task'}),detail=el('textarea',{rows:3});
    content.append(card('Desktop agent','Requests use the existing desktop bridge and its delivery policy.',submitForm([field('Request',command),field('Extra details',detail)],'Send request',async()=>{await result(await post('/api/mac/dispatch',{command:command.value,detail:detail.value}));await reload();})),card('Delivery status','',details('Desktop connection and pending requests',snapshot.mac)));
  }
  root.append(el('div',{class:'control-toolbar'},action('Refresh',reload,'quiet compact')),feedback,content);
  signal.addEventListener('abort',()=>{generation++;dispose();},{once:true});
  await reload();
  return ()=>{generation++;dispose();};
}
