/**
 * Install the daily run, the Pub/Sub event poller and the event-subscription
 * renewal trigger. This does not create Cloud resources by itself.
 */
function installAutomationTriggers() {
  assertCatalogConfiguration_();
  removeTriggersFor_('runDailyUtilitiesCataloging');
  removeTriggersFor_('processDriveEventQueue');
  removeTriggersFor_('renewDriveEventSubscription');

  ScriptApp.newTrigger('runDailyUtilitiesCataloging')
    .timeBased()
    .everyDays(1)
    .atHour(CONFIG.DAILY_TRIGGER_HOUR)
    .create();
  ScriptApp.newTrigger('processDriveEventQueue')
    .timeBased()
    .everyMinutes(CONFIG.EVENT_POLL_MINUTES)
    .create();
  ScriptApp.newTrigger('renewDriveEventSubscription')
    .timeBased()
    .everyHours(6)
    .create();

  return getSetupStatus();
}

function removeAutomationTriggers() {
  ['runDailyUtilitiesCataloging', 'processDriveEventQueue', 'renewDriveEventSubscription'].forEach(removeTriggersFor_);
}

function removeTriggersFor_(handlerFunction) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handlerFunction) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/**
 * Pull Workspace Drive events from Pub/Sub. The event itself is only a signal:
 * all processing still re-scans exactly the direct intake folder.
 */
function processDriveEventQueue() {
  const subscription = getScriptProperty_(CONFIG.PROPERTY_KEYS.PUBSUB_SUBSCRIPTION);
  if (!subscription) {
    console.log('Pub/Sub is not configured; no Drive events can be processed.');
    return { processed: false, reason: 'not-configured' };
  }

  const response = cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription + ':pull', {
    method: 'post',
    payload: JSON.stringify({ maxMessages: 10 })
  });
  const messages = response.receivedMessages || [];
  if (messages.length === 0) {
    return { processed: false, reason: 'empty' };
  }

  logCatalogEvent_('drive-event-received', { messageCount: messages.length });
  const result = runUtilitiesCataloging_('drive-event');
  const ackIds = messages.map(function (message) { return message.ackId; });
  cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription + ':acknowledge', {
    method: 'post',
    payload: JSON.stringify({ ackIds: ackIds })
  });
  logCatalogEvent_('drive-event-acknowledged', { messageCount: ackIds.length });
  return result;
}

/**
 * Create the Pub/Sub topic, pull subscription and Drive event subscription.
 * Before running it, associate this Apps Script project with a standard Cloud
 * project and enable Workspace Events API, Drive API and Pub/Sub API there.
 */
function provisionDriveEventTransport() {
  const projectId = getScriptProperty_(CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID);
  if (!projectId) {
    throw new Error('Configure GOOGLE_CLOUD_PROJECT_ID in Script Properties first.');
  }
  const topic = 'projects/' + projectId + '/topics/drive-utilities-events';
  const subscription = 'projects/' + projectId + '/subscriptions/drive-utilities-events-pull';

  ensurePubSubTopic_(topic);
  grantDrivePublisher_(topic);
  ensurePubSubPullSubscription_(subscription, topic);
  const properties = PropertiesService.getScriptProperties();
  properties.setProperties({
    PUBSUB_TOPIC: topic,
    PUBSUB_SUBSCRIPTION: subscription
  }, false);
  const eventSubscription = findDriveEventSubscription_() || createDriveEventSubscription_(topic);
  storeWorkspaceEventSubscription_(eventSubscription);
  return getSetupStatus();
}

function renewDriveEventSubscription() {
  const properties = PropertiesService.getScriptProperties();
  const topic = properties.getProperty(CONFIG.PROPERTY_KEYS.PUBSUB_TOPIC);
  if (!topic) {
    console.log('Drive event transport is not configured; renewal skipped.');
    return { renewed: false, reason: 'not-configured' };
  }

  const expiresAt = new Date(properties.getProperty(CONFIG.PROPERTY_KEYS.WORKSPACE_EVENT_EXPIRES_AT) || 0);
  if (expiresAt.getTime() - Date.now() > 12 * 60 * 60 * 1000) {
    return { renewed: false, reason: 'not-due' };
  }

  const current = properties.getProperty(CONFIG.PROPERTY_KEYS.WORKSPACE_EVENT_SUBSCRIPTION);
  if (current) {
    try {
      cloudFetch_('https://workspaceevents.googleapis.com/v1/' + current, { method: 'delete' });
    } catch (error) {
      console.warn('Could not delete the previous event subscription: ' + error.message);
    }
  }
  const subscription = createDriveEventSubscription_(topic);
  storeWorkspaceEventSubscription_(subscription);
  return { renewed: true, subscription: subscription.name };
}

function ensurePubSubTopic_(topic) {
  try {
    cloudFetch_('https://pubsub.googleapis.com/v1/' + topic, { method: 'get' });
  } catch (error) {
    if (error.message.indexOf('Google Cloud HTTP 404:') === -1) {
      throw error;
    }
    cloudFetch_('https://pubsub.googleapis.com/v1/' + topic, {
      method: 'put',
      payload: '{}'
    });
  }
}

function grantDrivePublisher_(topic) {
  const current = cloudFetch_('https://pubsub.googleapis.com/v1/' + topic + ':getIamPolicy', {
    method: 'get'
  });
  const policy = current || { bindings: [] };
  policy.bindings = policy.bindings || [];
  const role = 'roles/pubsub.publisher';
  const member = 'serviceAccount:drive-api-event-push@system.gserviceaccount.com';
  let binding = policy.bindings.filter(function (item) { return item.role === role; })[0];
  if (!binding) {
    binding = { role: role, members: [] };
    policy.bindings.push(binding);
  }
  if (binding.members.indexOf(member) === -1) {
    binding.members.push(member);
  }
  cloudFetch_('https://pubsub.googleapis.com/v1/' + topic + ':setIamPolicy', {
    method: 'post',
    payload: JSON.stringify({ policy: policy })
  });
}

function ensurePubSubPullSubscription_(subscription, topic) {
  try {
    cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription, { method: 'get' });
  } catch (error) {
    if (error.message.indexOf('Google Cloud HTTP 404:') === -1) {
      throw error;
    }
    cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription, {
      method: 'put',
      payload: JSON.stringify({ topic: topic, ackDeadlineSeconds: 60 })
    });
  }
}

function createDriveEventSubscription_(topic) {
  const operation = cloudFetch_('https://workspaceevents.googleapis.com/v1/subscriptions', {
    method: 'post',
    payload: JSON.stringify({
      targetResource: '//drive.googleapis.com/files/' + getRootFolderId_(),
      eventTypes: [
        'google.workspace.drive.file.v3.created',
        'google.workspace.drive.file.v3.moved',
        'google.workspace.drive.file.v3.contentChanged'
      ],
      payloadOptions: { includeResource: false },
      driveOptions: { includeDescendants: false },
      notificationEndpoint: { pubsubTopic: topic },
      ttl: '86400s'
    })
  });
  if (!operation.response || !operation.response.name) {
    throw new Error('Workspace Events did not return a Subscription in the create operation.');
  }
  return operation.response;
}

function findDriveEventSubscription_() {
  const targetResource = '//drive.googleapis.com/files/' + getRootFolderId_();
  const filter = 'event_types:"google.workspace.drive.file.v3.created" AND ' +
    'target_resource="' + targetResource + '"';
  const response = cloudFetch_('https://workspaceevents.googleapis.com/v1/subscriptions?filter=' +
    encodeURIComponent(filter), { method: 'get' });
  const subscriptions = response.subscriptions || [];
  return subscriptions.length ? subscriptions[0] : null;
}

function storeWorkspaceEventSubscription_(subscription) {
  if (!subscription || !subscription.name || !subscription.expireTime) {
    throw new Error('Workspace Events did not return a subscription name and expiry time.');
  }
  PropertiesService.getScriptProperties().setProperties({
    WORKSPACE_EVENT_SUBSCRIPTION: subscription.name,
    WORKSPACE_EVENT_EXPIRES_AT: subscription.expireTime
  }, false);
}

function cloudFetch_(url, options) {
  const response = UrlFetchApp.fetch(url, {
    method: options.method || 'get',
    contentType: 'application/json',
    payload: options.payload,
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  const text = response.getContentText();
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error('Google Cloud HTTP ' + response.getResponseCode() + ': ' + text);
  }
  return text ? JSON.parse(text) : {};
}
