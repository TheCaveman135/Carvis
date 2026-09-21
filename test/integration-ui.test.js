import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import appleTv from '../server/integrations/apple-tv.js';

const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function helpers(integrations=[]){
  const context=vm.createContext({URL,state:{data:{integrations}},window:{location:{origin:'https://carvis.example'}}});
  const metadata=source.slice(source.indexOf('const integrationCategories ='),source.indexOf('function integrationWorkspaceLink('));
  const groups=source.slice(source.indexOf('function integrationFieldGroup('),source.indexOf('function integrationFieldValue('));
  const values=source.slice(source.indexOf('function integrationFieldValue('),source.indexOf('function configureIntegration('));
  vm.runInContext(metadata+'\n'+groups+'\n'+values+'\nglobalThis.ui={integrationCategory,integrationDependencies,integrationWorkspaceUrl,integrationWorkspaceMissing,integrationMatchesSearch,integrationFieldGroup,integrationStatus,integrationFieldValue};',context);
  return context.ui;
}

test('workspace links accept only this installation origin and reject embedded credentials',()=>{
  const ui=helpers();
  assert.equal(ui.integrationWorkspaceUrl('/integrations/assistant-engine/'),'/integrations/assistant-engine/');
  assert.equal(ui.integrationWorkspaceUrl('https://carvis.example/integrations/assistant-engine/?view=protocols#active'),'/integrations/assistant-engine/?view=protocols#active');
  for(const unsafe of ['https://another.example/panel','//another.example/panel','javascript:alert(1)','data:text/html,hi','http://carvis.example/panel','https://owner:secret@carvis.example/panel','https://carvis.example:8443/panel',''])assert.equal(ui.integrationWorkspaceUrl(unsafe),null,unsafe);
});

test('catalog categories accept labels, canonical IDs and native integration fallbacks',()=>{
  const ui=helpers();
  assert.equal(ui.integrationCategory({id:'new-plugin',category:'Intelligence & routines'}),'intelligence-routines');
  assert.equal(ui.integrationCategory({id:'voice-engine',category:'voice-display'}),'voice-display');
  assert.equal(ui.integrationCategory({id:'home-assistant'}),'home-devices');
  assert.equal(ui.integrationCategory({id:'even-realities'}),'voice-display');
  assert.equal(ui.integrationCategory({id:'new-service'}),'connected-services');
});

test('enabled state stays distinct from connectivity and dependency readiness',()=>{
  const ui=helpers([{id:'home-assistant',name:'Home Assistant',enabled:false}]);
  assert.equal(ui.integrationStatus({id:'tv',enabled:false,status:'connected'}).label,'Disabled');
  assert.equal(ui.integrationStatus({id:'tv',enabled:true,configured:true,dependsOn:['home-assistant']}).tone,'attention');
  assert.equal(ui.integrationDependencies({dependsOn:['home-assistant']})[0].name,'Home Assistant');
  assert.equal(ui.integrationStatus({id:'tv',enabled:true,configured:true,dependsOn:[{id:'home-assistant',optional:true}]}).label,'Enabled');
  assert.equal(ui.integrationStatus({id:'tv',enabled:true,configured:true,status:'error'}).tone,'attention');
  assert.equal(ui.integrationStatus({id:'tv',enabled:true,configured:false}).label,'Enabled · setup needed');
});

test('settings preserve typed false and zero, retain blank secrets, and parse structures',()=>{
  const ui=helpers();
  assert.equal(ui.integrationFieldValue({key:'tv__silentNavigation',type:'boolean'},{checked:false,value:''}),false);
  assert.equal(ui.integrationFieldValue({key:'volume',type:'number',min:0,max:100},{value:'0'}),0);
  assert.equal(ui.integrationFieldValue({key:'apiKey',type:'password'},{value:''}),undefined);
  assert.equal(ui.integrationFieldValue({key:'retry',type:'number'},{value:''}),undefined);
  assert.equal(ui.integrationFieldValue({key:'rules',type:'json'},{value:''}),undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.integrationFieldValue({key:'routines__rules',type:'json'},{value:'{"enabled":false,"steps":[1,2]}'}))),{enabled:false,steps:[1,2]});
  assert.deepEqual([...ui.integrationFieldValue({key:'names',type:'string-array'},{value:'Living room\nBedroom\nLiving room\n'})],['Living room','Bedroom']);
  assert.deepEqual([...ui.integrationFieldValue({key:'entities',type:'entities'},{value:'light.a, light.b\nlight.a'})],['light.a','light.b']);
});

test('invalid JSON and out-of-range numbers stop a settings submission',()=>{
  const ui=helpers();
  assert.throws(()=>ui.integrationFieldValue({key:'rules',label:'Rules',type:'json'},{value:'{enabled:true}'}),/Rules: enter valid JSON/);
  assert.throws(()=>ui.integrationFieldValue({key:'threshold',label:'Threshold',type:'number',min:0,max:1},{value:'2'}),/Threshold: enter a number between 0 and 1/);
  assert.throws(()=>ui.integrationFieldValue({key:'threshold',type:'number'},{value:'NaN'}),/enter a number/);
});


test('setting searches find TV silence and both reply switches share an obvious section',()=>{
  const ui=helpers();
  assert.equal(ui.integrationMatchesSearch(appleTv,'silent navigation'),true);
  assert.equal(ui.integrationMatchesSearch(appleTv,'short playback'),true);
  assert.equal(ui.integrationMatchesSearch(appleTv,'camera recognition'),false);
  for(const key of ['silentNavigation','shortReplies']){
    const field=appleTv.fields.find(field=>field.key===key);
    assert.equal(field.default,true);
    assert.equal(ui.integrationFieldGroup(appleTv,field).label,'Reply behavior');
  }
});

test('workspace links respect both capability and workspace dependencies after disable',()=>{
  const ui=helpers([{id:'assistant-engine',name:'Assistant engine',enabled:false}]);
  assert.equal(ui.integrationWorkspaceMissing({dependsOn:['assistant-engine']})[0].name,'Assistant engine');
  assert.equal(ui.integrationWorkspaceMissing({workspaceDependsOn:['assistant-engine']}).length,1);
  assert.equal(ui.integrationWorkspaceMissing({dependsOn:['assistant-engine'],workspaceDependsOn:['assistant-engine']}).length,1);
  assert.equal(ui.integrationWorkspaceMissing({dependsOn:[{id:'assistant-engine',optional:true}]}).length,0);
});
