#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const driveEventsSource = fs.readFileSync(
  path.join(projectRoot, 'DriveEvents.gs'),
  'utf8'
);

function loadDriveEvents(cloudFetchImplementation) {
  const context = vm.createContext({
    ScriptApp: {
      getScriptId: () => 'test-script-id'
    },
    console
  });
  vm.runInContext(driveEventsSource, context, {
    filename: 'DriveEvents.gs'
  });
  context.cloudFetch_ = cloudFetchImplementation;
  return context;
}

function testTransportNamesAreInstallationSpecific() {
  const context = loadDriveEvents(() => ({}));

  assert.equal(
    context.getDriveEventTopicName_('example'),
    'projects/example/topics/drive-utilities-events-test-script-id'
  );
  assert.equal(
    context.getDriveEventPullSubscriptionName_('example'),
    'projects/example/subscriptions/' +
      'drive-utilities-events-pull-test-script-id'
  );
}

function testMatchingSubscriptionIsPreserved() {
  const requests = [];
  const topic = 'projects/example/topics/drive-utilities-events';
  const subscription =
    'projects/example/subscriptions/drive-utilities-events-pull';
  const context = loadDriveEvents((url, options) => {
    requests.push({ url, options });
    return {
      name: subscription,
      topic,
      ackDeadlineSeconds: 60
    };
  });

  context.ensurePubSubPullSubscription_(subscription, topic);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'get');
}

function testAckDeadlineIsRepaired() {
  const requests = [];
  const topic = 'projects/example/topics/drive-utilities-events';
  const subscription =
    'projects/example/subscriptions/drive-utilities-events-pull';
  const context = loadDriveEvents((url, options) => {
    requests.push({ url, options });
    if (options.method === 'get') {
      return {
        name: subscription,
        topic,
        ackDeadlineSeconds: 10
      };
    }
    return {};
  });

  context.ensurePubSubPullSubscription_(subscription, topic);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.method, 'patch');
  assert.equal(requests[1].url.endsWith(subscription), true);
  const payload = JSON.parse(requests[1].options.payload);
  assert.equal(payload.updateMask, 'ackDeadlineSeconds');
  assert.equal(payload.subscription.ackDeadlineSeconds, 60);
}

function testUnexpectedTopicIsRejected() {
  const topic = 'projects/example/topics/drive-utilities-events';
  const subscription =
    'projects/example/subscriptions/drive-utilities-events-pull';
  const context = loadDriveEvents(() => ({
    name: subscription,
    topic: 'projects/example/topics/unrelated',
    ackDeadlineSeconds: 60
  }));

  assert.throws(
    () => context.ensurePubSubPullSubscription_(subscription, topic),
    /unexpected topic/
  );
}

function testWorkspaceSubscriptionTopology() {
  const topic = 'projects/example/topics/drive-utilities-events';
  const context = loadDriveEvents(() => ({
    subscriptions: [{
      name: 'subscriptions/example',
      state: 'ACTIVE',
      notificationEndpoint: {
        pubsubTopic: topic
      },
      driveOptions: {
        includeDescendants: true
      }
    }]
  }));
  context.getRootFolderId_ = () => 'root-folder-id';

  const subscription = context.findDriveEventSubscription_(topic);

  assert.equal(subscription.name, 'subscriptions/example');
}

function testIncompatibleWorkspaceSubscriptionIsRejected() {
  const topic = 'projects/example/topics/drive-utilities-events';
  const context = loadDriveEvents(() => ({
    subscriptions: [{
      name: 'subscriptions/example',
      state: 'ACTIVE',
      notificationEndpoint: {
        pubsubTopic: 'projects/example/topics/unrelated'
      },
      driveOptions: {
        includeDescendants: true
      }
    }]
  }));
  context.getRootFolderId_ = () => 'root-folder-id';

  assert.throws(
    () => context.findDriveEventSubscription_(topic),
    /incompatible topology/
  );
}

testTransportNamesAreInstallationSpecific();
testMatchingSubscriptionIsPreserved();
testAckDeadlineIsRepaired();
testUnexpectedTopicIsRejected();
testWorkspaceSubscriptionTopology();
testIncompatibleWorkspaceSubscriptionIsRejected();

console.log('Drive event transport tests passed.');
