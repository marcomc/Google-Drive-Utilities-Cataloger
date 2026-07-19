#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const events = [];
const lockTimeouts = [];
let activeTriggers = [];
let failCreationFor = '';
let failDeletionFor = '';
let lockAvailable = true;
let lockReleases = 0;

function makeTrigger(handler, id) {
  return {
    getHandlerFunction: () => handler,
    getUniqueId: () => id
  };
}

function createTrigger(handler) {
  events.push(`create:${handler}`);
  if (handler === failCreationFor) {
    throw new Error(`cannot create ${handler}`);
  }
  const trigger = makeTrigger(handler, `new-${handler}`);
  activeTriggers.push(trigger);
  return trigger;
}

function triggerBuilder(handler) {
  return {
    timeBased() { return this; },
    everyDays() { return this; },
    atHour() { return this; },
    everyMinutes() { return this; },
    everyHours() { return this; },
    create() { return createTrigger(handler); }
  };
}

const context = vm.createContext({
  console,
  ScriptApp: {
    getProjectTriggers: () => activeTriggers.slice(),
    deleteTrigger: (trigger) => {
      const id = trigger.getUniqueId();
      events.push(`delete:${id}`);
      if (id === failDeletionFor) {
        throw new Error(`cannot delete ${id}`);
      }
      activeTriggers = activeTriggers.filter((candidate) =>
        candidate.getUniqueId() !== id);
    },
    newTrigger: triggerBuilder
  },
  LockService: {
    getScriptLock: () => ({
      tryLock: (timeout) => {
        lockTimeouts.push(timeout);
        return lockAvailable;
      },
      releaseLock: () => { lockReleases += 1; }
    })
  }
});

vm.runInContext(fs.readFileSync('Config.gs', 'utf8'), context);
vm.runInContext(fs.readFileSync('DriveEvents.gs', 'utf8'), context);
context.assertCatalogConfiguration_ = () => {};
context.getSetupStatus = () => ({ applicationVersion: '0.1.1' });

activeTriggers = [
  makeTrigger('runDailyUtilitiesCataloging', 'old-daily'),
  makeTrigger('processDriveEventQueue', 'old-poll'),
  makeTrigger('renewDriveEventSubscription', 'old-renewal'),
  makeTrigger('unmanagedHandler', 'unmanaged')
];
const installed = context.installAutomationTriggers();
assert.deepEqual(events, [
  'create:runDailyUtilitiesCataloging',
  'create:processDriveEventQueue',
  'create:renewDriveEventSubscription',
  'delete:old-daily',
  'delete:old-poll',
  'delete:old-renewal'
]);
assert.deepEqual(JSON.parse(JSON.stringify(installed)), {
  applicationVersion: '0.1.1',
  triggerCounts: {
    runDailyUtilitiesCataloging: 1,
    processDriveEventQueue: 1,
    renewDriveEventSubscription: 1
  },
  missingTriggerHandlers: [],
  duplicateTriggerHandlers: []
});
assert.deepEqual(lockTimeouts, [280000]);
assert.equal(lockReleases, 1);
assert.ok(activeTriggers.some((trigger) => trigger.getUniqueId() === 'unmanaged'));

events.length = 0;
activeTriggers = [
  makeTrigger('runDailyUtilitiesCataloging', 'old-daily'),
  makeTrigger('processDriveEventQueue', 'old-poll'),
  makeTrigger('renewDriveEventSubscription', 'old-renewal')
];
failCreationFor = 'processDriveEventQueue';
assert.throws(
  () => context.installAutomationTriggers(),
  /cannot create processDriveEventQueue/
);
assert.deepEqual(events, [
  'create:runDailyUtilitiesCataloging',
  'create:processDriveEventQueue',
  'delete:new-runDailyUtilitiesCataloging'
]);
assert.deepEqual(activeTriggers.map((trigger) => trigger.getUniqueId()).sort(), [
  'old-daily',
  'old-poll',
  'old-renewal'
]);

events.length = 0;
activeTriggers = [
  makeTrigger('runDailyUtilitiesCataloging', 'old-daily'),
  makeTrigger('processDriveEventQueue', 'old-poll'),
  makeTrigger('renewDriveEventSubscription', 'old-renewal')
];
failCreationFor = 'renewDriveEventSubscription';
failDeletionFor = 'new-runDailyUtilitiesCataloging';
assert.throws(
  () => context.installAutomationTriggers(),
  /cannot create renewDriveEventSubscription.*cannot delete new-runDailyUtilitiesCataloging/
);
assert.deepEqual(events, [
  'create:runDailyUtilitiesCataloging',
  'create:processDriveEventQueue',
  'create:renewDriveEventSubscription',
  'delete:new-runDailyUtilitiesCataloging',
  'delete:new-processDriveEventQueue'
]);
assert.equal(
  activeTriggers.some((trigger) =>
    trigger.getUniqueId() === 'new-processDriveEventQueue'),
  false
);

failCreationFor = '';
failDeletionFor = '';
events.length = 0;
lockTimeouts.length = 0;
context.removeAutomationTriggers();
assert.deepEqual(lockTimeouts, [10000]);
assert.deepEqual(activeTriggers, []);

activeTriggers = [
  makeTrigger('runDailyUtilitiesCataloging', 'daily-one'),
  makeTrigger('runDailyUtilitiesCataloging', 'daily-two')
];
const unhealthy = context.getAutomationTriggerStatus_();
assert.deepEqual(JSON.parse(JSON.stringify(unhealthy)), {
  triggerCounts: {
    runDailyUtilitiesCataloging: 2,
    processDriveEventQueue: 0,
    renewDriveEventSubscription: 0
  },
  missingTriggerHandlers: [
    'processDriveEventQueue',
    'renewDriveEventSubscription'
  ],
  duplicateTriggerHandlers: ['runDailyUtilitiesCataloging']
});

lockAvailable = false;
assert.throws(
  () => context.installAutomationTriggers(),
  /Another catalog operation is already running/
);

console.log('Automation trigger status tests passed.');
