import test from 'node:test';
import assert from 'node:assert/strict';

import { HAClient } from '../server/ha.js';

test('room labels follow Home Assistant entity assignments, then device assignments', () => {
  const ha = new HAClient();
  ha.areas = new Map([
    ['workspace', { area_id: 'workspace', name: 'workspace' }],
    ['bedroom', { area_id: 'bedroom', name: 'Bedroom' }],
  ]);
  ha.deviceAreas = new Map([['device-1', 'workspace']]);
  ha.entityDevices = new Map([
    ['light.workbench', 'device-1'],
    ['sensor.bedside', 'device-1'],
  ]);
  ha.entityAreas = new Map([['sensor.bedside', 'bedroom']]);

  assert.equal(ha.areaNameFor('light.workbench'), 'workspace');
  assert.equal(ha.areaNameFor('sensor.bedside'), 'Bedroom');
  assert.equal(ha.areaNameFor('sensor.unassigned'), 'Unassigned');
});
