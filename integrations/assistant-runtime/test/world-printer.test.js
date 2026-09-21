import test from 'node:test';
import assert from 'node:assert/strict';
import {WorldState,durationMinutes} from '../server/world.js';
function world(entries,observed=entries.map(e=>e.entity_id)){
 return new WorldState({states:new Map(entries.map(e=>[e.entity_id,e])),areaNameFor:()=> 'workspace'},()=>({entities:{observed,controlled:[]}}));
}
const entity=(id,state,unit)=>({entity_id:'sensor.'+id,state,attributes:{unit_of_measurement:unit},last_changed:new Date().toISOString()});
test('Bambu remaining hours become minutes, not a mislabeled fraction',()=>{
 const w=world([entity('p2s_printer_print_status','running'),entity('p2s_printer_remaining_time','0.0166666666666667','h'),entity('p2s_printer_print_progress','98','%')]);
 assert.equal(w.printer('P2S').remaining_minutes,1);assert.equal(w.printer('P2S').progress_percent,98);assert.equal(w.printer('P2S').printing,true);
});
test('printer selection never falls back to a different printer or reads unselected sensors',()=>{
 const entries=[entity('p2s_print_status','running'),entity('p2s_remaining_time','2','h')];
 assert.equal(world(entries).printer('X1C'),null);
 assert.equal(world(entries,['sensor.p2s_remaining_time']).printer('p2s'),null);
 assert.equal(world(entries,['sensor.p2s_print_status']).printer('p2s').remaining_minutes,null);
});
test('printer data stays with its printer and unavailable readings stay unknown',()=>{
 const w=world([entity('p2s_print_status','not_printing'),entity('p2s2_remaining_time','3','h'),entity('p2s_remaining_time','unavailable','h')]);
 assert.equal(w.printer('p2s').printing,false);
 assert.equal(w.printer('p2s').remaining_minutes,null);
 assert.equal(durationMinutes('unavailable','h'),null);assert.equal(durationMinutes('','h'),null);assert.equal(durationMinutes('1','unknown'),null);
 assert.equal(durationMinutes('90','s'),1.5);assert.equal(durationMinutes('12','min'),12);
});
