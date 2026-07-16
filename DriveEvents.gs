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
 * Pull Workspace Drive events from Pub/Sub and process only changed direct
 * intake PDFs identified by the event payload.
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

  const rootFolder = DriveApp.getFolderById(getRootFolderId_());
  const files = getEventIntakeFiles_(messages, rootFolder);
  logCatalogEvent_('drive-event-received', {
    messageCount: messages.length,
    eligibleIntakePdfCount: files.length
  });
  const results = processEligibleIntakeFiles_(files, rootFolder, 'drive-event');
  if (results.length > 0) {
    sendReportEmail_(results);
  }
  const ackIds = messages.map(function (message) { return message.ackId; });
  cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription + ':acknowledge', {
    method: 'post',
    payload: JSON.stringify({ ackIds: ackIds })
  });
  logCatalogEvent_('drive-event-acknowledged', { messageCount: ackIds.length });
  return { processed: files.length > 0, results: results };
}

function getEventIntakeFiles_(messages, rootFolder) {
  const fileIds = {};
  messages.forEach(function (receivedMessage) {
    const message = receivedMessage.message || {};
    const data = decodeWorkspaceEventData_(message.data);
    const fileId = data && data.file && data.file.id;
    if (fileId) {
      fileIds[fileId] = true;
    }
  });

  return Object.keys(fileIds).map(function (fileId) {
    try {
      return DriveApp.getFileById(fileId);
    } catch (error) {
      console.warn('Drive event file is no longer available: ' + fileId);
      return null;
    }
  }).filter(function (file) {
    return file && isDirectIntakePdf_(file, rootFolder);
  });
}

function decodeWorkspaceEventData_(encodedData) {
  if (!encodedData) {
    return null;
  }
  try {
    const bytes = Utilities.base64Decode(encodedData);
    return JSON.parse(Utilities.newBlob(bytes).getDataAsString());
  } catch (error) {
    console.warn('Could not decode a Workspace Drive event payload: ' + error.message);
    return null;
  }
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
  const topic = getDriveEventTopicName_(projectId);
  const subscription = getDriveEventPullSubscriptionName_(projectId);

  ensurePubSubTopic_(topic);
  grantDrivePublisher_(topic);
  ensurePubSubPullSubscription_(subscription, topic);
  const properties = PropertiesService.getScriptProperties();
  properties.setProperties({
    PUBSUB_TOPIC: topic,
    PUBSUB_SUBSCRIPTION: subscription
  }, false);
  const eventSubscription = findDriveEventSubscription_(topic) ||
    createDriveEventSubscription_(topic);
  storeWorkspaceEventSubscription_(eventSubscription);
  return getSetupStatus();
}

/**
 * Replace this automation's Drive event subscription while preserving the
 * shared Pub/Sub topic and pull subscription. Use only to repair an event
 * path that is configured but not receiving new-file notifications.
 */
function recreateDriveEventSubscription() {
  const projectId = getScriptProperty_(CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID);
  if (!projectId) {
    throw new Error('Configure GOOGLE_CLOUD_PROJECT_ID in Script Properties first.');
  }
  const topic = getDriveEventTopicName_(projectId);
  const subscription = getDriveEventPullSubscriptionName_(projectId);

  ensurePubSubTopic_(topic);
  grantDrivePublisher_(topic);
  ensurePubSubPullSubscription_(subscription, topic);

  const properties = PropertiesService.getScriptProperties();
  const current = properties.getProperty(CONFIG.PROPERTY_KEYS.WORKSPACE_EVENT_SUBSCRIPTION);
  if (current) {
    try {
      cloudFetch_('https://workspaceevents.googleapis.com/v1/' + current, { method: 'delete' });
    } catch (error) {
      if (error.message.indexOf('Google Cloud HTTP 404:') === -1) {
        throw error;
      }
    }
  }

  const eventSubscription = createDriveEventSubscription_(topic);
  properties.setProperties({
    PUBSUB_TOPIC: topic,
    PUBSUB_SUBSCRIPTION: subscription
  }, false);
  storeWorkspaceEventSubscription_(eventSubscription);
  return getSetupStatus();
}

function getDriveEventTopicName_(projectId) {
  return 'projects/' + projectId + '/topics/drive-utilities-events-' +
    ScriptApp.getScriptId();
}

function getDriveEventPullSubscriptionName_(projectId) {
  return 'projects/' + projectId +
    '/subscriptions/drive-utilities-events-pull-' +
    ScriptApp.getScriptId();
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
  let current;
  try {
    current = cloudFetch_(
      'https://pubsub.googleapis.com/v1/' + subscription,
      { method: 'get' }
    );
  } catch (error) {
    if (error.message.indexOf('Google Cloud HTTP 404:') === -1) {
      throw error;
    }
    cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription, {
      method: 'put',
      payload: JSON.stringify({ topic: topic, ackDeadlineSeconds: 60 })
    });
    return;
  }

  if (current.topic !== topic) {
    throw new Error(
      'Existing Pub/Sub pull subscription targets an unexpected topic.'
    );
  }
  if (Number(current.ackDeadlineSeconds) !== 60) {
    cloudFetch_(
      'https://pubsub.googleapis.com/v1/' + subscription,
      {
        method: 'patch',
        payload: JSON.stringify({
          subscription: {
            name: subscription,
            topic: topic,
            ackDeadlineSeconds: 60
          },
          updateMask: 'ackDeadlineSeconds'
        })
      }
    );
  }
}

function createDriveEventSubscription_(topic) {
  const operation = cloudFetch_('https://workspaceevents.googleapis.com/v1/subscriptions', {
    method: 'post',
    payload: JSON.stringify({
      targetResource: '//drive.googleapis.com/files/' + getRootFolderId_(),
      eventTypes: [
        'google.workspace.drive.file.v3.created'
      ],
      payloadOptions: { includeResource: false },
      // A folder target receives child-file changes only when this is true.
      driveOptions: { includeDescendants: true },
      notificationEndpoint: { pubsubTopic: topic },
      ttl: '86400s'
    })
  });
  if (!operation.response || !operation.response.name) {
    throw new Error('Workspace Events did not return a Subscription in the create operation.');
  }
  return operation.response;
}

function findDriveEventSubscription_(topic) {
  const targetResource = '//drive.googleapis.com/files/' + getRootFolderId_();
  const filter = 'event_types:"google.workspace.drive.file.v3.created" AND ' +
    'target_resource="' + targetResource + '"';
  const response = cloudFetch_('https://workspaceevents.googleapis.com/v1/subscriptions?filter=' +
    encodeURIComponent(filter), { method: 'get' });
  const subscriptions = response.subscriptions || [];
  const matching = subscriptions.filter(function (subscription) {
    return subscription.state === 'ACTIVE' &&
      subscription.notificationEndpoint &&
      subscription.notificationEndpoint.pubsubTopic === topic &&
      subscription.driveOptions &&
      subscription.driveOptions.includeDescendants === true;
  });
  if (matching.length > 1) {
    throw new Error(
      'Multiple active Workspace event subscriptions match this installation.'
    );
  }
  if (matching.length === 1) {
    return matching[0];
  }
  if (subscriptions.length > 0) {
    throw new Error(
      'An existing Workspace event subscription has incompatible topology.'
    );
  }
  return null;
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
