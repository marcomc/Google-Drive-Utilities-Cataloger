const AUTOMATION_TRIGGER_HANDLERS = Object.freeze([
  'runDailyUtilitiesCataloging',
  'processDriveEventQueue',
  'renewDriveEventSubscription'
]);

/**
 * Install the daily run, the Pub/Sub event poller and the event-subscription
 * renewal trigger. This does not create Cloud resources by itself.
 */
function installAutomationTriggers() {
  return withCatalogLifecycleLock_('install-triggers', function () {
    return installAutomationTriggersUnlocked_();
  }, CONFIG.MAX_RUNTIME_MS);
}

function installAutomationTriggersUnlocked_() {
  assertCatalogConfiguration_();
  const properties = PropertiesService.getScriptProperties();
  const storedSchedules = getStoredAutomationTriggerSchedules_(properties);
  const triggersByHandler = getManagedAutomationTriggersByHandler_();
  AUTOMATION_TRIGGER_HANDLERS.forEach(function (handler) {
    triggersByHandler[handler].slice(1).forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
  });
  AUTOMATION_TRIGGER_HANDLERS.forEach(function (handler) {
    const schedule = getAutomationTriggerSchedule_(handler);
    if (triggersByHandler[handler].length === 0) {
      createManagedAutomationTrigger_(handler, schedule);
    } else if (Object.prototype.hasOwnProperty.call(storedSchedules, handler) &&
      !sameAutomationTriggerSchedule_(storedSchedules[handler], schedule)) {
      replaceManagedAutomationTrigger_(triggersByHandler[handler][0], handler, schedule);
    }
    storedSchedules[handler] = schedule;
    properties.setProperty(
      CONFIG.PROPERTY_KEYS.AUTOMATION_TRIGGER_SCHEDULES,
      JSON.stringify(storedSchedules)
    );
  });

  return Object.assign({}, getSetupStatus(), getAutomationTriggerStatus_());
}

function getAutomationTriggerSchedule_(handler) {
  switch (handler) {
    case 'runDailyUtilitiesCataloging':
      return { frequency: 'daily', hour: CONFIG.DAILY_TRIGGER_HOUR };
    case 'processDriveEventQueue':
      return { frequency: 'minutes', interval: CONFIG.EVENT_POLL_MINUTES };
    case 'renewDriveEventSubscription':
      return { frequency: 'hours', interval: 6 };
    default:
      throw new Error('Unknown managed trigger handler: ' + handler);
  }
}

function createManagedAutomationTrigger_(handler, schedule) {
  switch (schedule.frequency) {
    case 'daily':
      return ScriptApp.newTrigger(handler)
        .timeBased()
        .everyDays(1)
        .atHour(schedule.hour)
        .create();
    case 'minutes':
      return ScriptApp.newTrigger(handler)
        .timeBased()
        .everyMinutes(schedule.interval)
        .create();
    case 'hours':
      return ScriptApp.newTrigger(handler)
        .timeBased()
        .everyHours(schedule.interval)
        .create();
    default:
      throw new Error('Unknown managed trigger schedule for: ' + handler);
  }
}

function replaceManagedAutomationTrigger_(existing, handler, schedule) {
  const replacement = createManagedAutomationTrigger_(handler, schedule);
  try {
    ScriptApp.deleteTrigger(existing);
  } catch (error) {
    try {
      ScriptApp.deleteTrigger(replacement);
    } catch (cleanupError) {
      error.message += ' Replacement trigger cleanup also failed: ' + cleanupError.message;
    }
    throw error;
  }
}

function removeAutomationTriggers() {
  return withCatalogLifecycleLock_('remove-triggers', function () {
    getManagedAutomationTriggers_().forEach(function (trigger) {
      ScriptApp.deleteTrigger(trigger);
    });
  });
}

function getManagedAutomationTriggers_() {
  return ScriptApp.getProjectTriggers().filter(function (trigger) {
    return AUTOMATION_TRIGGER_HANDLERS.indexOf(trigger.getHandlerFunction()) >= 0;
  });
}

function getManagedAutomationTriggersByHandler_() {
  const triggersByHandler = AUTOMATION_TRIGGER_HANDLERS.reduce(function (triggers, handler) {
    triggers[handler] = [];
    return triggers;
  }, {});
  getManagedAutomationTriggers_().forEach(function (trigger) {
    triggersByHandler[trigger.getHandlerFunction()].push(trigger);
  });
  return triggersByHandler;
}

function getStoredAutomationTriggerSchedules_(properties) {
  const serialized = properties.getProperty(
    CONFIG.PROPERTY_KEYS.AUTOMATION_TRIGGER_SCHEDULES
  );
  if (!serialized) {
    return {};
  }
  try {
    const schedules = JSON.parse(serialized);
    return schedules && typeof schedules === 'object' ? schedules : {};
  } catch (error) {
    return {};
  }
}

function sameAutomationTriggerSchedule_(stored, expected) {
  return JSON.stringify(stored) === JSON.stringify(expected);
}

function getAutomationTriggerStatus_() {
  const triggerCounts = AUTOMATION_TRIGGER_HANDLERS.reduce(function (counts, handler) {
    counts[handler] = 0;
    return counts;
  }, {});
  getManagedAutomationTriggers_().forEach(function (trigger) {
    triggerCounts[trigger.getHandlerFunction()] += 1;
  });
  const missingTriggerHandlers = AUTOMATION_TRIGGER_HANDLERS.filter(function (handler) {
    return triggerCounts[handler] === 0;
  });
  const duplicateTriggerHandlers = AUTOMATION_TRIGGER_HANDLERS.filter(function (handler) {
    return triggerCounts[handler] > 1;
  });
  return {
    triggerCounts: triggerCounts,
    missingTriggerHandlers: missingTriggerHandlers,
    duplicateTriggerHandlers: duplicateTriggerHandlers
  };
}

/**
 * Pull Workspace Drive events from Pub/Sub and process only changed direct
 * intake PDFs identified by the event payload.
 */
function processDriveEventQueue() {
  assertCatalogConfiguration_();
  return withCatalogProcessingLock_('drive-event', function () {
    return processDriveEventQueueUnlocked_();
  });
}

function processDriveEventQueueUnlocked_() {
  const properties = PropertiesService.getScriptProperties();
  const topic = properties.getProperty(CONFIG.PROPERTY_KEYS.PUBSUB_TOPIC);
  const subscription = properties.getProperty(
    CONFIG.PROPERTY_KEYS.PUBSUB_SUBSCRIPTION
  );
  if (!topic && !subscription) {
    console.log('Pub/Sub is not configured; no Drive events can be processed.');
    logCatalogEvent_('catalog-run-completed', {
      resultCount: 0,
      triggerSource: 'drive-event'
    });
    return { processed: false, reason: 'not-configured' };
  }
  const projectId = properties.getProperty(
    CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID
  );
  if (!projectId) {
    throw new Error('Google Cloud project is not configured.');
  }
  assertStoredPubSubTransportIdentity_(properties, projectId, false);
  const rootFolder = DriveApp.getFolderById(getRootFolderId_());
  const recoveredResults = recoverPendingMutations_(rootFolder);
  flushPendingReports_();

  const response = cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription + ':pull', {
    method: 'post',
    payload: JSON.stringify({ maxMessages: 1 })
  });
  const messages = response.receivedMessages || [];
  if (messages.length === 0) {
    logCatalogEvent_('catalog-run-completed', {
      resultCount: recoveredResults.length,
      triggerSource: 'drive-event'
    });
    return {
      processed: recoveredResults.length > 0,
      reason: 'empty',
      results: recoveredResults
    };
  }
  const ackIds = messages.map(function (message) { return message.ackId; });
  assertStoredPubSubTransportIdentity_(properties, projectId, false);
  cloudFetch_('https://pubsub.googleapis.com/v1/' +
    subscription + ':modifyAckDeadline', {
    method: 'post',
    payload: JSON.stringify({ ackIds: ackIds, ackDeadlineSeconds: 300 })
  });

  const files = getEventIntakeFiles_(messages, rootFolder);
  logCatalogEvent_('drive-event-received', {
    messageCount: messages.length,
    eligibleIntakePdfCount: files.length
  });
  const batch = processEligibleIntakeFiles_(files, rootFolder, 'drive-event');
  finalizeCatalogResults_(batch.state, batch.results);
  assertStoredPubSubTransportIdentity_(properties, projectId, false);
  cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription + ':acknowledge', {
    method: 'post',
    payload: JSON.stringify({ ackIds: ackIds })
  });
  logCatalogEvent_('drive-event-acknowledged', { messageCount: ackIds.length });
  logCatalogEvent_('catalog-run-completed', {
    resultCount: recoveredResults.length + batch.results.length,
    triggerSource: 'drive-event'
  });
  return {
    processed: files.length > 0 || recoveredResults.length > 0,
    results: recoveredResults.concat(batch.results)
  };
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
    console.warn('Could not decode a Workspace Drive event payload.');
    return null;
  }
}

/**
 * Create the Pub/Sub topic, pull subscription and Drive event subscription.
 * Before running it, associate this Apps Script project with a standard Cloud
 * project and enable Workspace Events API, Drive API and Pub/Sub API there.
 */
function provisionDriveEventTransport() {
  return withCatalogLifecycleLock_('provision-event-transport', function () {
    return provisionDriveEventTransportUnlocked_();
  });
}

function provisionDriveEventTransportUnlocked_() {
  const projectId = getScriptProperty_(CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID);
  if (!projectId) {
    throw new Error('Configure GOOGLE_CLOUD_PROJECT_ID in Script Properties first.');
  }
  const properties = PropertiesService.getScriptProperties();
  assertStoredPubSubTransportIdentity_(properties, projectId, true);
  const topic = getDriveEventTopicName_(projectId);
  const subscription = getDriveEventPullSubscriptionName_(projectId);

  ensurePubSubTopic_(topic);
  grantDrivePublisher_(topic);
  ensurePubSubPullSubscription_(subscription, topic);
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
 * Replace this automation's Drive event subscription and reconcile its
 * installation-specific Pub/Sub topic and pull subscription. Use only to
 * repair an event path that is configured but not receiving notifications.
 */
function recreateDriveEventSubscription() {
  return withCatalogLifecycleLock_('recreate-event-subscription', function () {
    return recreateDriveEventSubscriptionUnlocked_();
  });
}

function recreateDriveEventSubscriptionUnlocked_() {
  const projectId = getScriptProperty_(CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID);
  if (!projectId) {
    throw new Error('Configure GOOGLE_CLOUD_PROJECT_ID in Script Properties first.');
  }
  const properties = PropertiesService.getScriptProperties();
  assertStoredPubSubTransportIdentity_(properties, projectId, false);
  const topic = getDriveEventTopicName_(projectId);
  const subscription = getDriveEventPullSubscriptionName_(projectId);

  ensurePubSubTopic_(topic);
  grantDrivePublisher_(topic);
  ensurePubSubPullSubscription_(subscription, topic);

  const current = properties.getProperty(CONFIG.PROPERTY_KEYS.WORKSPACE_EVENT_SUBSCRIPTION);
  if (current) {
    try {
      const live = getWorkspaceEventSubscription_(current);
      assertWorkspaceEventOwnership_(live, topic);
      waitForWorkspaceOperation_(cloudFetch_(
        'https://workspaceevents.googleapis.com/v1/' + current,
        { method: 'delete' }
      ), false);
    } catch (error) {
      if (!isUnavailableWorkspaceEventSubscriptionError_(error)) {
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
  return withCatalogLifecycleLock_('renew-event-subscription', function () {
    return renewDriveEventSubscriptionUnlocked_();
  });
}

function renewDriveEventSubscriptionUnlocked_() {
  const properties = PropertiesService.getScriptProperties();
  const storedTopic = properties.getProperty(CONFIG.PROPERTY_KEYS.PUBSUB_TOPIC);
  const storedPull = properties.getProperty(
    CONFIG.PROPERTY_KEYS.PUBSUB_SUBSCRIPTION
  );
  if (!storedTopic && !storedPull) {
    console.log('Drive event transport is not configured; renewal skipped.');
    return { renewed: false, reason: 'not-configured' };
  }
  const projectId = properties.getProperty(
    CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID
  );
  if (!projectId) {
    throw new Error('Google Cloud project is not configured.');
  }
  assertStoredPubSubTransportIdentity_(properties, projectId, false);
  const topic = getDriveEventTopicName_(projectId);

  const current = properties.getProperty(CONFIG.PROPERTY_KEYS.WORKSPACE_EVENT_SUBSCRIPTION);
  if (!current) {
    const created = createDriveEventSubscription_(topic);
    storeWorkspaceEventSubscription_(created);
    return { renewed: true, subscription: created.name };
  }
  let live;
  try {
    live = getWorkspaceEventSubscription_(current);
  } catch (error) {
    if (isInaccessibleWorkspaceEventSubscriptionError_(error)) {
      recreateDriveEventSubscriptionUnlocked_();
      return {
        renewed: true,
        reason: 'inaccessible-subscription-recreated'
      };
    }
    if (!isCloudHttpStatus_(error, 404)) {
      throw error;
    }
    const replacement = createDriveEventSubscription_(topic);
    storeWorkspaceEventSubscription_(replacement);
    return {
      renewed: true,
      reason: 'missing-subscription-recreated',
      subscription: replacement.name
    };
  }
  assertWorkspaceEventTopology_(live, topic);
  const expiresAt = new Date(live.expireTime || 0);
  if (expiresAt.getTime() - Date.now() > 12 * 60 * 60 * 1000) {
    storeWorkspaceEventSubscription_(live);
    return { renewed: false, reason: 'not-due' };
  }
  const operation = cloudFetch_(
    'https://workspaceevents.googleapis.com/v1/' + current +
      '?updateMask=ttl',
    {
      method: 'patch',
      payload: JSON.stringify({ ttl: '0s' })
    }
  );
  const subscription = waitForWorkspaceOperation_(operation);
  storeWorkspaceEventSubscription_(subscription);
  return { renewed: true, subscription: subscription.name };
}

function assertStoredPubSubTransportIdentity_(properties, projectId,
  allowUnconfigured) {
  const topic = properties.getProperty(CONFIG.PROPERTY_KEYS.PUBSUB_TOPIC);
  const pull = properties.getProperty(
    CONFIG.PROPERTY_KEYS.PUBSUB_SUBSCRIPTION
  );
  if (allowUnconfigured && !topic && !pull) {
    return;
  }
  if (topic !== getDriveEventTopicName_(projectId) ||
    pull !== getDriveEventPullSubscriptionName_(projectId)) {
    throw new Error(
      'Stored Pub/Sub transport names do not match this Apps Script project. ' +
      'Repair the installation before changing the Workspace subscription.'
    );
  }
}

function isUnavailableWorkspaceEventSubscriptionError_(error) {
  return isCloudHttpStatus_(error, 404) ||
    isInaccessibleWorkspaceEventSubscriptionError_(error);
}

function isInaccessibleWorkspaceEventSubscriptionError_(error) {
  return isCloudHttpStatus_(error, 403) &&
    error.cloudReason === 'SUBSCRIPTION_ACCESS_DENIED';
}

function isCloudHttpStatus_(error, statusCode) {
  return Number(error && error.cloudHttpStatus) === statusCode;
}

function withCatalogLifecycleLock_(operation, callback, timeoutMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs || 10000)) {
    throw new Error('Another catalog operation is already running: ' + operation);
  }
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function ensurePubSubTopic_(topic) {
  try {
    cloudFetch_('https://pubsub.googleapis.com/v1/' + topic, { method: 'get' });
  } catch (error) {
    if (!isCloudHttpStatus_(error, 404)) {
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
  let binding = policy.bindings.filter(function (item) {
    return item.role === role && !item.condition;
  })[0];
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
    if (!isCloudHttpStatus_(error, 404)) {
      throw error;
    }
    cloudFetch_('https://pubsub.googleapis.com/v1/' + subscription, {
      method: 'put',
      payload: JSON.stringify({ topic: topic, ackDeadlineSeconds: 300 })
    });
    return;
  }

  if (current.topic !== topic) {
    throw new Error(
      'Existing Pub/Sub pull subscription targets an unexpected topic.'
    );
  }
  if (Number(current.ackDeadlineSeconds) !== 300) {
    cloudFetch_(
      'https://pubsub.googleapis.com/v1/' + subscription,
      {
        method: 'patch',
        payload: JSON.stringify({
          subscription: {
            name: subscription,
            topic: topic,
            ackDeadlineSeconds: 300
          },
          updateMask: 'ackDeadlineSeconds'
        })
      }
    );
  }
}

function createDriveEventSubscription_(topic) {
  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const operation = cloudFetch_(
        'https://workspaceevents.googleapis.com/v1/subscriptions',
        {
          method: 'post',
          payload: JSON.stringify({
            targetResource: '//drive.googleapis.com/files/' + getRootFolderId_(),
            eventTypes: getDriveWorkspaceEventTypes_(),
            payloadOptions: { includeResource: false },
            // A folder target receives child-file changes only when this is true.
            driveOptions: { includeDescendants: true },
            notificationEndpoint: { pubsubTopic: topic }
          })
        }
      );
      return waitForWorkspaceOperation_(operation);
    } catch (error) {
      lastError = error;
      if (!/permission|publisher|403/i.test(error.message) || attempt === 6) {
        throw error;
      }
      Utilities.sleep(Math.min(60000, 5000 * Math.pow(2, attempt - 1)));
    }
  }
  throw lastError;
}

function getDriveWorkspaceEventTypes_() {
  return [
    'google.workspace.drive.file.v3.created',
    'google.workspace.drive.file.v3.moved',
    'google.workspace.drive.file.v3.contentChanged'
  ];
}

function waitForWorkspaceOperation_(operation, expectSubscription) {
  const requireSubscription = expectSubscription !== false;
  let current = operation || {};
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (current.error) {
      throw new Error('Workspace Events operation failed: ' +
        String(current.error.message || JSON.stringify(current.error)));
    }
    if (current.response) {
      if (requireSubscription && !current.response.name) {
        throw new Error('Workspace Events returned an invalid Subscription.');
      }
      return current.response;
    }
    if (requireSubscription && current.name && current.expireTime) {
      return current;
    }
    if (!current.name) {
      throw new Error('Workspace Events did not return an operation name.');
    }
    if (current.done === true) {
      if (!requireSubscription) {
        return {};
      }
      throw new Error('Workspace Events operation completed without a Subscription.');
    }
    Utilities.sleep(2000);
    current = cloudFetch_(
      'https://workspaceevents.googleapis.com/v1/' + current.name,
      { method: 'get' }
    );
  }
  throw new Error('Workspace Events operation did not complete in time.');
}

function findDriveEventSubscription_(topic) {
  const targetResource = '//drive.googleapis.com/files/' + getRootFolderId_();
  const filter = 'event_types:"google.workspace.drive.file.v3.created" AND ' +
    'target_resource="' + targetResource + '"';
  const response = cloudFetch_('https://workspaceevents.googleapis.com/v1/subscriptions?filter=' +
    encodeURIComponent(filter), { method: 'get' });
  const subscriptions = response.subscriptions || [];
  const matching = subscriptions.filter(function (subscription) {
    try {
      assertWorkspaceEventTopology_(subscription, topic);
      return true;
    } catch (error) {
      return false;
    }
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

function getWorkspaceEventSubscription_(name) {
  return cloudFetch_(
    'https://workspaceevents.googleapis.com/v1/' + name,
    { method: 'get' }
  );
}

function assertWorkspaceEventOwnership_(subscription, topic) {
  const targetResource = '//drive.googleapis.com/files/' + getRootFolderId_();
  if (!subscription || subscription.targetResource !== targetResource ||
    !subscription.notificationEndpoint ||
    subscription.notificationEndpoint.pubsubTopic !== topic) {
    throw new Error(
      'Stored Workspace event subscription is not owned by this installation.'
    );
  }
}

function assertWorkspaceEventTopology_(subscription, topic) {
  assertWorkspaceEventOwnership_(subscription, topic);
  const eventTypes = subscription.eventTypes || [];
  if (subscription.state !== 'ACTIVE' ||
    !subscription.driveOptions ||
    subscription.driveOptions.includeDescendants !== true ||
    !getDriveWorkspaceEventTypes_().every(function (eventType) {
      return eventTypes.indexOf(eventType) >= 0;
    })) {
    throw new Error('Workspace event subscription topology is invalid.');
  }
}

function validateDriveEventTopology_() {
  const projectId = getScriptProperty_(CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID);
  const expectedTopic = getDriveEventTopicName_(projectId);
  const expectedPull = getDriveEventPullSubscriptionName_(projectId);
  const properties = PropertiesService.getScriptProperties();
  if (properties.getProperty(CONFIG.PROPERTY_KEYS.PUBSUB_TOPIC) !== expectedTopic ||
    properties.getProperty(CONFIG.PROPERTY_KEYS.PUBSUB_SUBSCRIPTION) !== expectedPull) {
    throw new Error('Stored Pub/Sub resource names do not match this installation.');
  }
  cloudFetch_('https://pubsub.googleapis.com/v1/' + expectedTopic, { method: 'get' });
  const pull = cloudFetch_(
    'https://pubsub.googleapis.com/v1/' + expectedPull,
    { method: 'get' }
  );
  if (pull.topic !== expectedTopic || Number(pull.ackDeadlineSeconds) !== 300) {
    throw new Error('Live Pub/Sub subscription topology is invalid.');
  }
  const workspaceName = properties.getProperty(
    CONFIG.PROPERTY_KEYS.WORKSPACE_EVENT_SUBSCRIPTION
  );
  if (!workspaceName) {
    throw new Error('Workspace event subscription is not configured.');
  }
  const workspace = getWorkspaceEventSubscription_(workspaceName);
  assertWorkspaceEventTopology_(workspace, expectedTopic);
  if (new Date(workspace.expireTime).getTime() <= Date.now()) {
    throw new Error('Workspace event subscription is expired.');
  }
  return workspace;
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
    throw createCloudHttpError_(response.getResponseCode(), text);
  }
  return text ? JSON.parse(text) : {};
}

function createCloudHttpError_(statusCode, responseText) {
  const error = new Error(
    'Google Cloud HTTP ' + statusCode + ': ' + responseText
  );
  error.cloudHttpStatus = Number(statusCode);
  error.cloudReason = '';
  try {
    const body = JSON.parse(responseText);
    const details = body && body.error && body.error.details;
    if (Array.isArray(details)) {
      const detail = details.filter(function (item) {
        return item && typeof item.reason === 'string';
      })[0];
      error.cloudReason = detail ? detail.reason : '';
    }
  } catch (parseError) {
    error.cloudReason = '';
  }
  return error;
}
