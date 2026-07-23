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
let nextTriggerId = 0;
const scriptProperties = new Map();

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
  const trigger = makeTrigger(handler, `new-${handler}-${++nextTriggerId}`);
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
  },
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: (key) => scriptProperties.has(key) ? scriptProperties.get(key) : null,
      setProperty: (key, value) => scriptProperties.set(key, value)
    })
  }
});

vm.runInContext(fs.readFileSync('Config.gs', 'utf8'), context);
vm.runInContext(fs.readFileSync('DriveEvents.gs', 'utf8'), context);
context.assertCatalogConfiguration_ = () => {};
const applicationVersion = vm.runInContext('CONFIG.APP_VERSION', context);
context.getSetupStatus = () => ({ applicationVersion });

activeTriggers = [makeTrigger('unmanagedHandler', 'unmanaged')];
const installed = context.installAutomationTriggers();
assert.deepEqual(events, [
  'create:runDailyUtilitiesCataloging',
  'create:processDriveEventQueue',
  'create:renewDriveEventSubscription'
]);
assert.deepEqual(JSON.parse(JSON.stringify(installed)), {
  applicationVersion,
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
context.installAutomationTriggers();
assert.deepEqual(events, []);

scriptProperties.delete('AUTOMATION_TRIGGER_SCHEDULES');
events.length = 0;
context.installAutomationTriggers();
assert.deepEqual(events, []);
assert.deepEqual(
  JSON.parse(scriptProperties.get('AUTOMATION_TRIGGER_SCHEDULES')),
  {
    runDailyUtilitiesCataloging: { frequency: 'daily', hour: 7 },
    processDriveEventQueue: { frequency: 'minutes', interval: 15 },
    renewDriveEventSubscription: { frequency: 'hours', interval: 6 }
  }
);

const storedSchedules = JSON.parse(scriptProperties.get('AUTOMATION_TRIGGER_SCHEDULES'));
storedSchedules.processDriveEventQueue = { frequency: 'minutes', interval: 5 };
scriptProperties.set('AUTOMATION_TRIGGER_SCHEDULES', JSON.stringify(storedSchedules));
const originalPollTriggerId = activeTriggers.find((trigger) =>
  trigger.getHandlerFunction() === 'processDriveEventQueue').getUniqueId();
events.length = 0;
context.installAutomationTriggers();
assert.deepEqual(events, [
  'create:processDriveEventQueue',
  `delete:${originalPollTriggerId}`
]);
assert.equal(
  activeTriggers.filter((trigger) =>
    trigger.getHandlerFunction() === 'processDriveEventQueue').length,
  1
);
assert.deepEqual(
  JSON.parse(scriptProperties.get('AUTOMATION_TRIGGER_SCHEDULES')).processDriveEventQueue,
  { frequency: 'minutes', interval: 15 }
);

const refreshedPollTriggerId = activeTriggers.find((trigger) =>
  trigger.getHandlerFunction() === 'processDriveEventQueue').getUniqueId();
storedSchedules.processDriveEventQueue = { frequency: 'minutes', interval: 5 };
scriptProperties.set('AUTOMATION_TRIGGER_SCHEDULES', JSON.stringify(storedSchedules));
failDeletionFor = refreshedPollTriggerId;
events.length = 0;
assert.throws(
  () => context.installAutomationTriggers(),
  new RegExp(`cannot delete ${refreshedPollTriggerId}`)
);
assert.equal(events[0], 'create:processDriveEventQueue');
assert.equal(events[1], `delete:${refreshedPollTriggerId}`);
assert.match(events[2], /^delete:new-processDriveEventQueue-/);
assert.deepEqual(
  activeTriggers.filter((trigger) =>
    trigger.getHandlerFunction() === 'processDriveEventQueue').map((trigger) =>
    trigger.getUniqueId()),
  [refreshedPollTriggerId]
);

failDeletionFor = '';
events.length = 0;
context.installAutomationTriggers();
assert.deepEqual(events, [
  'create:processDriveEventQueue',
  `delete:${refreshedPollTriggerId}`
]);

events.length = 0;
activeTriggers = [];
failCreationFor = 'processDriveEventQueue';
assert.throws(
  () => context.installAutomationTriggers(),
  /cannot create processDriveEventQueue/
);
assert.deepEqual(events, [
  'create:runDailyUtilitiesCataloging',
  'create:processDriveEventQueue'
]);
assert.deepEqual(activeTriggers.map((trigger) => trigger.getHandlerFunction()), [
  'runDailyUtilitiesCataloging'
]);

failCreationFor = '';
events.length = 0;
context.installAutomationTriggers();
assert.deepEqual(events, [
  'create:processDriveEventQueue',
  'create:renewDriveEventSubscription'
]);
assert.equal(context.getAutomationTriggerStatus_().missingTriggerHandlers.length, 0);

events.length = 0;
activeTriggers = [
  makeTrigger('runDailyUtilitiesCataloging', 'daily-one'),
  makeTrigger('runDailyUtilitiesCataloging', 'daily-two'),
  makeTrigger('processDriveEventQueue', 'poll-one'),
  makeTrigger('renewDriveEventSubscription', 'renewal-one')
];
failDeletionFor = 'daily-two';
assert.throws(
  () => context.installAutomationTriggers(),
  /cannot delete daily-two/
);
assert.deepEqual(events, ['delete:daily-two']);
assert.equal(activeTriggers.length, 4);

failDeletionFor = '';
events.length = 0;
context.installAutomationTriggers();
assert.deepEqual(events, ['delete:daily-two']);
assert.equal(context.getAutomationTriggerStatus_().duplicateTriggerHandlers.length, 0);

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
