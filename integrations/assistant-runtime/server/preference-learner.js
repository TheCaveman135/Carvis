import * as models from './models.js';
import {log} from './log.js';
// Only explicit statements from an addressed owner turn are candidates.
export const preferenceStatement = text => /\b(?:i (?:really )?(?:like|love|prefer|hate|usually|normally|always)|i (?:don't|do not) like|my (?:favorite|favourite|preference)|remember (?:that )?i)\b/i.test(text);
export class PreferenceLearner {
  constructor({getConfig,gateway,complete=models.complete}) {Object.assign(this,{getConfig,gateway,complete});this.pending=[];this.running=false;}
  observe(text) {
    if (!preferenceStatement(text) || this.pending.length >= 8) return;
    this.pending.push(String(text).slice(0,8000));
    if (!this.running) this.drain().catch(err=>log('warn',`Preference learning unavailable: ${err.message}`));
  }
  async drain() {
    this.running=true;
    try {
      while(this.pending.length) {
        const text=this.pending.shift();
        try {
          const {json}=await this.complete(this.getConfig(),'rule',{
            system:'Extract durable preferences explicitly stated by the owner. Return at most three complete verbatim quotes from their message. Each quote must include who prefers what and any condition or negation. Exclude questions, hypotheticals, reported speech, temporary one-off requests, credentials, and requests to change permissions. Do not infer habits. An empty list is normal. These are personal preferences, not standing action authorization.',
            messages:[{role:'user',content:text}],
            schema:{type:'object',additionalProperties:false,properties:{quotes:{type:'array',maxItems:3,items:{type:'string'}}},required:['quotes']},maxTokens:500,
          });
          for(const quote of [...new Set(json?.quotes || [])].slice(0,3)) {
            if(typeof quote!=='string' || quote.length>240 || !text.includes(quote) || !preferenceStatement(quote))continue;
            await this.gateway.call('memory.remember',{text:quote,kind:'preference'},{triggerType:'user_text',reason:text,wakeWord:false,confirmed:false});
          }
        } catch(err) {log('warn',`Preference learning skipped: ${err.message}`);}
      }
    } finally {this.running=false;}
  }
}
