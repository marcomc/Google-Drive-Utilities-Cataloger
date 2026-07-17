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
    CONFIG: {
      PROPERTY_KEYS: {
        GOOGLE_CLOUD_PROJECT_ID: 'GOOGLE_CLOUD_PROJECT_ID',
        PUBSUB_TOPIC: 'PUBSUB_TOPIC',
        PUBSUB_SUBSCRIPTION: 'PUBSUB_SUBSCRIPTION',
        WORKSPACE_EVENT_SUBSCRIPTION: 'WORKSPACE_EVENT_SUBSCRIPTION',
        WORKSPACE_EVENT_EXPIRES_AT: 'WORKSPACE_EVENT_EXPIRES_AT'
      }
    },
    ScriptApp: {
      getScriptId: () => 'test-script-id'
    },
    Utilities: {
      sleep: () => {}
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
      ackDeadlineSeconds: 300
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
  assert.equal(payload.subscription.ackDeadlineSeconds, 300);
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

function testDrivePublisherUsesUnconditionalIamBinding() {
  const requests = [];
  const topic = 'projects/example/topics/drive-utilities-events';
  const context = loadDriveEvents((url, options) => {
    requests.push({ url, options });
    if (url.endsWith(':getIamPolicy')) {
      return {
        bindings: [{
          role: 'roles/pubsub.publisher',
          members: ['serviceAccount:conditional@example.test'],
          condition: {
            title: 'limited',
            expression: 'request.time < timestamp("2030-01-01T00:00:00Z")'
          }
        }]
      };
    }
    return {};
  });

  context.grantDrivePublisher_(topic);

  const payload = JSON.parse(requests[1].options.payload);
  const publisherBindings = payload.policy.bindings.filter(
    (binding) => binding.role === 'roles/pubsub.publisher'
  );
  assert.equal(publisherBindings.length, 2);
  assert.equal(
    publisherBindings.filter((binding) => !binding.condition).length,
    1
  );
  assert.deepEqual(
    publisherBindings.find((binding) => !binding.condition).members,
    ['serviceAccount:drive-api-event-push@system.gserviceaccount.com']
  );
}

function testWorkspaceSubscriptionTopology() {
  const topic = 'projects/example/topics/drive-utilities-events';
  const context = loadDriveEvents(() => ({
    subscriptions: [{
      name: 'subscriptions/example',
      state: 'ACTIVE',
      targetResource: '//drive.googleapis.com/files/root-folder-id',
      eventTypes: [
        'google.workspace.drive.file.v3.created',
        'google.workspace.drive.file.v3.moved',
        'google.workspace.drive.file.v3.contentChanged'
      ],
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
      targetResource: '//drive.googleapis.com/files/root-folder-id',
      eventTypes: [
        'google.workspace.drive.file.v3.created'
      ],
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

function testWorkspaceSubscriptionRequestsAllIntakeEvents() {
  const requests = [];
  const context = loadDriveEvents((url, options) => {
    requests.push({ url, options });
    return {
      response: {
        name: 'subscriptions/example',
        expireTime: '2030-01-01T00:00:00Z'
      }
    };
  });
  context.getRootFolderId_ = () => 'root-folder-id';

  context.createDriveEventSubscription_(
    'projects/example/topics/drive-utilities-events'
  );

  const payload = JSON.parse(requests[0].options.payload);
  assert.equal(payload.ttl, '0s');
  assert.deepEqual(
    Array.from(payload.eventTypes),
    [
      'google.workspace.drive.file.v3.created',
      'google.workspace.drive.file.v3.moved',
      'google.workspace.drive.file.v3.contentChanged'
    ]
  );
}

function testWorkspaceOperationIsPolled() {
  let polls = 0;
  const context = loadDriveEvents(() => {
    polls += 1;
    return {
      done: true,
      response: {
        name: 'subscriptions/example',
        expireTime: '2030-01-01T00:00:00Z'
      }
    };
  });

  const subscription = context.waitForWorkspaceOperation_({
    name: 'operations/example',
    done: false
  });

  assert.equal(polls, 1);
  assert.equal(subscription.name, 'subscriptions/example');
}

function testPublisherPermissionPropagationIsRetried() {
  let attempts = 0;
  const delays = [];
  const context = loadDriveEvents(() => {
    attempts += 1;
    if (attempts < 3) {
      throw new Error('Google Cloud HTTP 403: publisher permission pending');
    }
    return {
      response: {
        name: 'subscriptions/example',
        expireTime: '2030-01-01T00:00:00Z'
      }
    };
  });
  context.Utilities.sleep = (delay) => delays.push(delay);
  context.getRootFolderId_ = () => 'root-folder-id';

  const subscription = context.createDriveEventSubscription_(
    'projects/example/topics/drive-utilities-events'
  );

  assert.equal(subscription.name, 'subscriptions/example');
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5000, 10000]);
}

function testRenewalPatchesMaximumTtl() {
  const requests = [];
  const stored = {
    PUBSUB_TOPIC: 'projects/example/topics/drive-utilities-events',
    WORKSPACE_EVENT_SUBSCRIPTION: 'subscriptions/example'
  };
  const context = loadDriveEvents((url, options) => {
    requests.push({ url, options });
    return {
      response: {
        name: 'subscriptions/example',
        expireTime: '2030-01-01T00:00:00Z'
      }
    };
  });
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored[key] || '',
      setProperties: (values) => Object.assign(stored, values)
    })
  };
  context.getWorkspaceEventSubscription_ = () => ({
    name: 'subscriptions/example',
    state: 'ACTIVE',
    expireTime: new Date(Date.now() + 60 * 60 * 1000).toISOString()
  });
  context.assertWorkspaceEventTopology_ = () => {};

  const result = context.renewDriveEventSubscriptionUnlocked_();

  assert.equal(result.renewed, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.method, 'patch');
  assert.match(requests[0].url, /updateMask=ttl$/);
  assert.deepEqual(JSON.parse(requests[0].options.payload), { ttl: '0s' });
}

function testRenewalRecreatesMissingStoredSubscription() {
  const stored = {
    PUBSUB_TOPIC: 'projects/example/topics/drive-utilities-events',
    WORKSPACE_EVENT_SUBSCRIPTION: 'subscriptions/missing'
  };
  const context = loadDriveEvents(() => ({}));
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored[key] || '',
      setProperties: (values) => Object.assign(stored, values)
    })
  };
  context.getWorkspaceEventSubscription_ = () => {
    throw new Error('Google Cloud HTTP 404: missing');
  };
  context.createDriveEventSubscription_ = () => ({
    name: 'subscriptions/replacement',
    expireTime: '2030-01-01T00:00:00Z'
  });

  const result = context.renewDriveEventSubscriptionUnlocked_();

  assert.equal(result.renewed, true);
  assert.equal(result.reason, 'missing-subscription-recreated');
  assert.equal(stored.WORKSPACE_EVENT_SUBSCRIPTION, 'subscriptions/replacement');
}

function testRecreateDeletesOnlyOwnedSubscription() {
  const requests = [];
  const stored = {
    WORKSPACE_EVENT_SUBSCRIPTION: 'subscriptions/example'
  };
  const context = loadDriveEvents((url, options) => {
    requests.push({ url, options });
    return { response: {} };
  });
  context.getScriptProperty_ = () => 'example';
  context.ensurePubSubTopic_ = () => {};
  context.grantDrivePublisher_ = () => {};
  context.ensurePubSubPullSubscription_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.getWorkspaceEventSubscription_ = () => ({
    name: 'subscriptions/example',
    targetResource: '//drive.googleapis.com/files/root-folder-id',
    notificationEndpoint: {
      pubsubTopic:
        'projects/example/topics/drive-utilities-events-test-script-id'
    }
  });
  context.createDriveEventSubscription_ = () => ({
    name: 'subscriptions/replacement',
    expireTime: '2030-01-01T00:00:00Z'
  });
  context.PropertiesService = {
    getScriptProperties: () => ({
      getProperty: (key) => stored[key] || '',
      setProperties: (values) => Object.assign(stored, values)
    })
  };
  context.getSetupStatus = () => ({ pubSubConfigured: true });

  context.recreateDriveEventSubscriptionUnlocked_();

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://workspaceevents.googleapis.com/v1/subscriptions/example'
  );
  assert.equal(requests[0].options.method, 'delete');
  assert.equal(stored.WORKSPACE_EVENT_SUBSCRIPTION, 'subscriptions/replacement');
}

testTransportNamesAreInstallationSpecific();
testMatchingSubscriptionIsPreserved();
testAckDeadlineIsRepaired();
testUnexpectedTopicIsRejected();
testDrivePublisherUsesUnconditionalIamBinding();
testWorkspaceSubscriptionTopology();
testIncompatibleWorkspaceSubscriptionIsRejected();
testWorkspaceSubscriptionRequestsAllIntakeEvents();
testWorkspaceOperationIsPolled();
testPublisherPermissionPropagationIsRetried();
testRenewalPatchesMaximumTtl();
testRenewalRecreatesMissingStoredSubscription();
testRecreateDeletesOnlyOwnedSubscription();

console.log('Drive event transport tests passed.');
