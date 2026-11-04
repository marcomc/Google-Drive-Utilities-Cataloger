/**
 * Discover stable Flash-Lite candidates independently for each enabled
 * provider. Catalog membership is only metadata; a candidate is retained only
 * after a bounded generation probe succeeds with that provider's credentials.
 */
function isAutomaticGeminiModelSelectionEnabled_() {
  return getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_MODEL_AUTO_SELECTION) ===
    'true';
}

function configureGeminiModelSelection(policy) {
  const normalizedPolicy = String(policy || '').trim();
  if (normalizedPolicy !== 'latest_ga_flash_lite' && normalizedPolicy !== 'pinned') {
    throw new Error(
      'Model selection policy must be latest_ga_flash_lite or pinned.');
  }
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(
    CONFIG.PROPERTY_KEYS.GEMINI_MODEL_AUTO_SELECTION,
    String(normalizedPolicy === 'latest_ga_flash_lite')
  );
  if (normalizedPolicy === 'latest_ga_flash_lite') {
    properties.deleteProperty(CONFIG.PROPERTY_KEYS.GEMINI_MODEL_SELECTIONS);
  }
  return getSetupStatus();
}

function getGeminiModelSelectionStatus_() {
  const selection = readGeminiModelSelections_();
  return {
    policy: isAutomaticGeminiModelSelectionEnabled_() ?
      'latest_ga_flash_lite' : 'pinned',
    geminiApiModel: selection.gemini_api && selection.gemini_api.model || '',
    vertexAiModel: selection.vertex_ai && selection.vertex_ai.model || '',
    geminiApiCheckedAt: selection.gemini_api &&
      selection.gemini_api.checkedAt || '',
    vertexAiCheckedAt: selection.vertex_ai &&
      selection.vertex_ai.checkedAt || ''
  };
}

function getGeminiModelForBackend_(backend) {
  if (!isAutomaticGeminiModelSelectionEnabled_()) {
    return getGeminiModel_();
  }
  const candidates = getGeminiModelCandidatesForBackend_(backend);
  if (!candidates.length) {
    throw new Error('No verified GA Flash-Lite model is available for ' + backend + '.');
  }
  return candidates[0];
}

function getGeminiDeveloperModelCandidatesPinned_() {
  return [getGeminiModel_()];
}

function getGeminiModelCandidatesForBackend_(backend, forceRefresh, deadlineAt) {
  if (['gemini_api', 'vertex_ai'].indexOf(backend) < 0) {
    throw new Error('Unsupported Gemini model-selection backend.');
  }
  if (!isAutomaticGeminiModelSelectionEnabled_()) {
    return backend === 'gemini_api' ? getGeminiDeveloperModelCandidatesPinned_() :
      [getGeminiModel_()];
  }

  const selections = readGeminiModelSelections_();
  const previous = selections[backend];
  const isFresh = previous && Number(previous.checkedAtMs) > 0 &&
    Date.now() - Number(previous.checkedAtMs) <
      CONFIG.GEMINI_MODEL_SELECTION_REFRESH_MS;
  if (!forceRefresh && isFresh && Array.isArray(previous.candidates) &&
    previous.candidates.length && previous.model === previous.candidates[0]) {
    return previous.candidates.slice();
  }
  if (!forceRefresh && previous && previous.model &&
    Array.isArray(previous.candidates) &&
    previous.candidates.indexOf(previous.model) >= 0) {
    logCatalogEvent_('gemini-model-catalog-refresh-deferred', {
      backend: backend,
      reason: 'stale-cache-used-as-last-known-good',
      retainedLastKnownGood: true
    });
    return previous.candidates.slice();
  }
  if (!forceRefresh) {
    const refreshRequired = new Error(
      'Gemini model cache is missing; refresh model selections outside PDF processing.');
    refreshRequired.geminiModelSelectionRefreshRequired = true;
    throw refreshRequired;
  }

  let catalogCandidates;
  try {
    catalogCandidates = backend === 'gemini_api' ?
      listGeminiDeveloperFlashLiteCandidates_('', deadlineAt) :
      listVertexFlashLiteCandidates_(deadlineAt);
  } catch (error) {
    if (previous && previous.model && Array.isArray(previous.candidates) &&
      previous.candidates.indexOf(previous.model) >= 0 &&
      error && error.geminiCatalogTransient === true) {
      logCatalogEvent_('gemini-model-catalog-refresh-deferred', {
        backend: backend,
        reason: 'transient-catalog-error',
        retainedLastKnownGood: true
      });
      return previous.candidates.slice();
    }
    throw error;
  }
  if (!catalogCandidates.length) {
    throw new Error('The ' + backend + ' catalog returned no GA Flash-Lite candidates.');
  }

  const verifiedCandidates = [];
  let retryableProbeFailure = false;
  for (let index = 0; index < catalogCandidates.length; index += 1) {
    if (index >= CONFIG.GEMINI_MODEL_SELECTION_MAX_CANDIDATES) {
      break;
    }
    const model = catalogCandidates[index];
    try {
      assertGeminiFlashEscalationBudget_(deadlineAt);
      probeGeminiModelForBackend_(backend, model);
      verifiedCandidates.push(model);
    } catch (error) {
      if (error && error.extractionEscalationBudgetExhausted === true) {
        throw error;
      }
      if (error && error.geminiModelProbeAuthFailure === true) {
        throw error;
      }
      if (error && error.geminiModelProbeTransient === true) {
        retryableProbeFailure = true;
        break;
      }
      logCatalogEvent_('gemini-model-candidate-rejected', {
        backend: backend,
        model: model,
        reason: error && error.geminiModelProbeReason || 'generation-probe-failed'
      });
    }
  }

  if (!verifiedCandidates.length && retryableProbeFailure && previous && previous.model &&
    Array.isArray(previous.candidates) && previous.candidates.indexOf(previous.model) >= 0) {
    logCatalogEvent_('gemini-model-selection-retained', {
      backend: backend,
      model: previous.model,
      reason: 'transient-generation-probe-failure'
    });
    return previous.candidates.slice();
  }
  if (!verifiedCandidates.length) {
    throw new Error('No GA Flash-Lite candidate passed generation readiness for ' +
      backend + '.');
  }

  // Persist only IDs that passed inference with this provider's identity.
  // A later request can advance to the next verified, economic candidate if
  // the newest model becomes unavailable or quota limited.
  const selectedModel = verifiedCandidates[0];
  const orderedCandidates = verifiedCandidates;
  selections[backend] = {
    model: selectedModel,
    candidates: orderedCandidates,
    checkedAt: new Date().toISOString(),
    checkedAtMs: Date.now()
  };
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.PROPERTY_KEYS.GEMINI_MODEL_SELECTIONS,
    JSON.stringify(selections)
  );
  logCatalogEvent_('gemini-model-selected', {
    backend: backend,
    model: selectedModel,
    candidateCount: orderedCandidates.length,
    policy: 'latest_ga_flash_lite'
  });
  return orderedCandidates;
}

function readGeminiModelSelections_() {
  const raw = getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_MODEL_SELECTIONS);
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    logCatalogEvent_('gemini-model-selection-state-invalid', {
      reason: 'invalid-json'
    });
    return {};
  }
}

function listGeminiDeveloperFlashLiteCandidates_() {
  return listGeminiDeveloperFlashCandidatesByTier_('flash-lite',
    arguments.length > 0 ? arguments[0] : '',
    arguments.length > 1 ? arguments[1] : 0);
}

function listGeminiDeveloperFlashCandidates_() {
  return listGeminiDeveloperFlashCandidatesByTier_('flash',
    arguments.length > 0 ? arguments[0] : '',
    arguments.length > 1 ? arguments[1] : 0);
}

function listGeminiDeveloperFlashCandidatesByTier_(tier, suppliedApiKey,
  deadlineAt) {
  const apiKey = suppliedApiKey ||
    getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_API_KEY);
  if (!apiKey) {
    throw new Error('Gemini Developer API key is required for model discovery.');
  }
  const models = [];
  let pageToken = '';
  let pageCount = 0;
  do {
    if (pageCount++ >= CONFIG.GEMINI_MODEL_CATALOG_MAX_PAGES) {
      const incomplete = new Error('Gemini catalog pagination exceeded the maintenance bound.');
      incomplete.geminiCatalogTransient = true;
      throw incomplete;
    }
    assertGeminiFlashEscalationBudget_(deadlineAt);
    logCatalogEvent_('gemini-model-catalog-requested', {
      provider: 'Gemini Developer API', tier: tier
    });
    const query = ['pageSize=1000'];
    if (pageToken) {
      query.push('pageToken=' + encodeURIComponent(pageToken));
    }
    const response = fetchGeminiModelCatalog_(
      'https://generativelanguage.googleapis.com/v1beta/models?' + query.join('&'),
      { 'x-goog-api-key': apiKey }, 'Gemini Developer API');
    logCatalogEvent_('gemini-model-catalog-response', {
      provider: 'Gemini Developer API', tier: tier,
      statusCode: response.getResponseCode()
    });
    const page = JSON.parse(response.getContentText());
    (Array.isArray(page.models) ? page.models : []).forEach(function (model) {
      if (!model || !Array.isArray(model.supportedGenerationMethods) ||
        model.supportedGenerationMethods.indexOf('generateContent') < 0) {
        return;
      }
      const modelId = String(model.baseModelId || model.name || '')
        .replace(/^models\//, '');
      if (isStableGeminiModelIdForTier_(modelId, tier)) {
        models.push(modelId);
      }
    });
    pageToken = String(page.nextPageToken || '');
  } while (pageToken);
  return sortGeminiModelsForTier_(models, tier);
}

function listVertexFlashLiteCandidates_() {
  return listVertexFlashCandidatesByTier_('flash-lite',
    arguments.length > 0 ? arguments[0] : 0);
}

function listVertexFlashCandidates_() {
  return listVertexFlashCandidatesByTier_('flash',
    arguments.length > 0 ? arguments[0] : 0);
}

function listVertexFlashCandidatesByTier_(tier, deadlineAt) {
  const models = [];
  let pageToken = '';
  let pageCount = 0;
  do {
    if (pageCount++ >= CONFIG.GEMINI_MODEL_CATALOG_MAX_PAGES) {
      const incomplete = new Error('Gemini catalog pagination exceeded the maintenance bound.');
      incomplete.geminiCatalogTransient = true;
      throw incomplete;
    }
    assertGeminiFlashEscalationBudget_(deadlineAt);
    logCatalogEvent_('gemini-model-catalog-requested', {
      provider: 'Vertex AI', tier: tier
    });
    const query = [
      'pageSize=' + CONFIG.GEMINI_VERTEX_CATALOG_PAGE_SIZE,
      'listAllVersions=true'
    ];
    if (pageToken) {
      query.push('pageToken=' + encodeURIComponent(pageToken));
    }
    const response = fetchGeminiModelCatalog_(
      'https://aiplatform.googleapis.com/v1beta1/publishers/google/models?' +
        query.join('&'),
      { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, 'Vertex AI');
    logCatalogEvent_('gemini-model-catalog-response', {
      provider: 'Vertex AI', tier: tier,
      statusCode: response.getResponseCode()
    });
    const page = JSON.parse(response.getContentText());
    (Array.isArray(page.publisherModels) ? page.publisherModels : []).forEach(
      function (model) {
        if (!model || model.launchStage !== 'GA' ||
          (model.versionState &&
            ['STABLE', 'VERSION_STATE_STABLE'].indexOf(model.versionState) < 0)) {
          return;
        }
        const modelId = String(model.name || '').split('/models/').pop()
          .split('@')[0];
        if (isStableGeminiModelIdForTier_(modelId, tier)) {
          models.push(modelId);
        }
      }
    );
    pageToken = String(page.nextPageToken || '');
  } while (pageToken);
  return sortGeminiModelsForTier_(models, tier);
}

function fetchGeminiModelCatalog_(url, headers, provider) {
  let response;
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: headers,
      muteHttpExceptions: true
    });
  } catch (error) {
    const failure = new Error(provider + ' model catalog request failed.');
    failure.geminiCatalogTransient = true;
    throw failure;
  }
  const status = response.getResponseCode();
  if (status !== 200) {
    const failure = new Error(provider + ' model catalog failed (HTTP ' + status + ').');
    failure.geminiCatalogTransient = [408, 429, 500, 502, 503, 504].indexOf(status) >= 0;
    failure.geminiCatalogAuthFailure = [401, 403].indexOf(status) >= 0;
    throw failure;
  }
  try {
    JSON.parse(response.getContentText());
  } catch (error) {
    throw new Error(provider + ' model catalog returned invalid JSON.');
  }
  return response;
}

function isStableFlashLiteModelId_(modelId) {
  return isGeminiFlashLiteModel_(modelId);
}

function isStableGeminiModelIdForTier_(modelId, tier) {
  return tier === 'flash-lite' ? isStableFlashLiteModelId_(modelId) :
    tier === 'flash' && /^gemini-[0-9]+(?:\.[0-9]+)*-flash$/.test(
      String(modelId || ''));
}

function sortGeminiModelsForTier_(models, tier) {
  if (tier === 'flash-lite') {
    return sortFlashLiteModelIds_(models);
  }
  const versions = {};
  models.forEach(function (model) {
    const normalized = String(model || '');
    if (isStableGeminiModelIdForTier_(normalized, tier)) {
      versions[normalized] = normalized.replace(/^gemini-/, '')
        .replace(/-flash$/, '').split('.').map(Number);
    }
  });
  return Object.keys(versions).sort(function (left, right) {
    const leftVersion = versions[left];
    const rightVersion = versions[right];
    const length = Math.max(leftVersion.length, rightVersion.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (rightVersion[index] || 0) - (leftVersion[index] || 0);
      if (difference) {
        return difference;
      }
    }
    return left.localeCompare(right);
  });
}

function getGeminiFlashEscalationModelForBackend_(backend, deadlineAt) {
  if (['gemini_api', 'vertex_ai'].indexOf(backend) < 0 ||
    !isAutomaticGeminiModelSelectionEnabled_()) {
    throw new Error('Automatic Flash escalation is unavailable for this backend.');
  }
  const propertyKey = CONFIG.PROPERTY_KEYS.GEMINI_MODEL_ESCALATION_SELECTIONS;
  const raw = getScriptProperty_(propertyKey);
  let selections = {};
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      selections = parsed;
    }
  } catch (error) {
    selections = {};
  }
  const previous = selections[backend];
  const isFresh = previous && isStableGeminiModelIdForTier_(previous.model, 'flash') &&
    Number(previous.checkedAtMs) > 0 &&
    Date.now() - Number(previous.checkedAtMs) < CONFIG.GEMINI_MODEL_SELECTION_REFRESH_MS;
  if (isFresh) {
    return previous.model;
  }
  if (previous && isStableGeminiModelIdForTier_(previous.model, 'flash') &&
    Number(previous.checkedAtMs) > 0) {
    logCatalogEvent_('gemini-model-selection-retained', {
      backend: backend,
      model: previous.model,
      reason: 'stale-last-known-good-cache'
    });
    return previous.model;
  }

  const refreshRequired = new Error(
    'Flash escalation model cache is missing or stale; refresh it outside PDF processing.');
  refreshRequired.geminiModelCatalogRefreshRequired = true;
  throw refreshRequired;
}

/**
 * Refresh the provider-specific GA Flash escalation cache outside PDF
 * processing. Catalog HTTP calls have no caller-configurable timeout in Apps
 * Script, so they must never run on an invoice-processing execution path.
 */
function refreshGeminiFlashEscalationModelForBackend_(backend, deadlineAt) {
  if (['gemini_api', 'vertex_ai'].indexOf(backend) < 0 ||
    !isAutomaticGeminiModelSelectionEnabled_()) {
    throw new Error('Automatic Flash escalation is unavailable for this backend.');
  }
  const propertyKey = CONFIG.PROPERTY_KEYS.GEMINI_MODEL_ESCALATION_SELECTIONS;
  const raw = getScriptProperty_(propertyKey);
  let selections = {};
  try {
    const parsed = JSON.parse(raw || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      selections = parsed;
    }
  } catch (error) {
    selections = {};
  }
  const previous = selections[backend];

  let candidates;
  try {
    candidates = backend === 'gemini_api' ?
      listGeminiDeveloperFlashCandidates_('', deadlineAt) :
      listVertexFlashCandidates_(deadlineAt);
  } catch (error) {
    if (previous && isStableGeminiModelIdForTier_(previous.model, 'flash') &&
      error && error.geminiCatalogTransient === true) {
      return previous.model;
    }
    throw error;
  }
  let selected = '';
  for (let index = 0; index < candidates.length &&
    index < CONFIG.GEMINI_MODEL_SELECTION_MAX_CANDIDATES; index += 1) {
    try {
      assertGeminiFlashEscalationBudget_(deadlineAt);
      probeGeminiModelForBackend_(backend, candidates[index]);
      selected = candidates[index];
      break;
    } catch (error) {
      if (error && error.extractionEscalationBudgetExhausted === true) {
        throw error;
      }
      if (error && error.geminiModelProbeAuthFailure === true) {
        throw error;
      }
      if (error && error.geminiModelProbeTransient === true) {
        logCatalogEvent_('gemini-model-candidate-deferred', {
          backend: backend,
          model: candidates[index],
          reason: 'transient-generation-probe-failure'
        });
        continue;
      }
    }
  }
  if (!selected) {
    if (previous && isStableGeminiModelIdForTier_(previous.model, 'flash') &&
      Number(previous.checkedAtMs) > 0) {
      logCatalogEvent_('gemini-model-selection-retained', {
        backend: backend,
        model: previous.model,
        reason: 'no-new-candidate-passed-generation-probe'
      });
      return previous.model;
    }
    throw new Error('No GA Flash model passed generation readiness for ' + backend + '.');
  }
  selections[backend] = { model: selected, checkedAtMs: Date.now() };
  PropertiesService.getScriptProperties().setProperty(propertyKey,
    JSON.stringify(selections));
  return selected;
}

/** Refresh one due provider/tier per execution, independently of PDF intake. */
function maintainGeminiModelSelections() {
  if (!isAutomaticGeminiModelSelectionEnabled_()) {
    return { skipped: 'pinned-model' };
  }
  const deadlineAt = Date.now() + CONFIG.MAX_RUNTIME_MS;
  return withCatalogProcessingLock_('model-selection-maintenance', function () {
    const properties = PropertiesService.getScriptProperties();
    const key = CONFIG.PROPERTY_KEYS.GEMINI_MODEL_MAINTENANCE_ATTEMPTS;
    let attempts;
    let flashSelections;
    try { attempts = JSON.parse(properties.getProperty(key) || '{}'); } catch (_) { attempts = {}; }
    try {
      flashSelections = JSON.parse(properties.getProperty(
        CONFIG.PROPERTY_KEYS.GEMINI_MODEL_ESCALATION_SELECTIONS) || '{}');
    } catch (_) { flashSelections = {}; }
    attempts = attempts && typeof attempts === 'object' && !Array.isArray(attempts) ? attempts : {};
    flashSelections = flashSelections && typeof flashSelections === 'object' ? flashSelections : {};
    const liteSelections = readGeminiModelSelections_();
    const primary = getGeminiBackend_();
    const backends = primary === 'gemini_api' && isAutomaticVertexFallbackEnabled_() ?
      ['gemini_api', 'vertex_ai'] : [primary];
    const jobs = ['flash-lite', 'flash'].reduce(function (all, tier) {
      return all.concat(backends.map(function (backend) {
        const selection = (tier === 'flash-lite' ? liteSelections : flashSelections)[backend];
        const id = backend + ':' + tier;
        return { id: id, backend: backend, tier: tier,
          lastAttempt: Math.max(Number(attempts[id]) || 0,
            Number(selection && selection.checkedAtMs) || 0) };
      }));
    }, []).filter(function (job) {
      return Date.now() - job.lastAttempt >= CONFIG.GEMINI_MODEL_SELECTION_REFRESH_MS;
    }).sort(function (a, b) {
      if (a.tier !== b.tier) {
        return a.tier === 'flash-lite' ? -1 : 1;
      }
      return a.lastAttempt - b.lastAttempt;
    });
    if (!jobs.length) {
      return { skipped: 'fresh-model-selections' };
    }
    const job = jobs[0];
    // Checkpoint before provider I/O so even a hard timeout lets other pairs
    // advance next time; failed pairs retain their last verified model.
    attempts[job.id] = Date.now();
    properties.setProperty(key, JSON.stringify(attempts));
    try {
      assertGeminiFlashEscalationBudget_(deadlineAt);
      const model = job.tier === 'flash-lite' ?
        getGeminiModelCandidatesForBackend_(job.backend, true, deadlineAt)[0] :
        refreshGeminiFlashEscalationModelForBackend_(job.backend, deadlineAt);
      const updated = job.tier === 'flash-lite' ? readGeminiModelSelections_() :
        JSON.parse(properties.getProperty(
          CONFIG.PROPERTY_KEYS.GEMINI_MODEL_ESCALATION_SELECTIONS) || '{}');
      const refreshed = Number(updated[job.backend] &&
        updated[job.backend].checkedAtMs) >= attempts[job.id];
      logCatalogEvent_(refreshed ? 'gemini-model-maintenance-completed' :
        'gemini-model-maintenance-deferred', {
        backend: job.backend, tier: job.tier, model: model, retained: !refreshed
      });
      return { backend: job.backend, tier: job.tier, model: model,
        refreshed: refreshed, retained: !refreshed, deferred: !refreshed };
    } catch (error) {
      logCatalogEvent_('gemini-model-maintenance-deferred', {
        backend: job.backend, tier: job.tier, reason: classifyCatalogErrorForLog_(error)
      });
      return { backend: job.backend, tier: job.tier, deferred: true };
    }
  });
}

/** Owner-only maintenance operation; does not read or mutate invoice data. */
function refreshGeminiModelSelectionCaches() {
  const deadlineAt = Date.now() + CONFIG.MAX_RUNTIME_MS;
  return withCatalogProcessingLock_('model-selection-maintenance', function () {
    return refreshGeminiModelSelectionCachesUnlocked_(deadlineAt);
  });
}

function refreshGeminiModelSelectionCachesUnlocked_(deadlineAt) {
  if (!isAutomaticGeminiModelSelectionEnabled_()) {
    throw new Error('Automatic Gemini model selection is disabled.');
  }
  const primaryBackend = getGeminiBackend_();
  const backends = primaryBackend === 'gemini_api' &&
    isAutomaticVertexFallbackEnabled_() ? ['gemini_api', 'vertex_ai'] :
    [primaryBackend];
  const refreshed = [];
  backends.forEach(function (backend) {
    const flashLiteCandidates = getGeminiModelCandidatesForBackend_(backend, true, deadlineAt);
    const flashModel = refreshGeminiFlashEscalationModelForBackend_(backend, deadlineAt);
    const liteSelection = readGeminiModelSelections_()[backend];
    const escalationSelection = JSON.parse(getScriptProperty_(
      CONFIG.PROPERTY_KEYS.GEMINI_MODEL_ESCALATION_SELECTIONS) || '{}')[backend];
    refreshed.push({
      backend: backend,
      flashLiteModel: flashLiteCandidates[0],
      flashLiteCheckedAt: liteSelection && liteSelection.checkedAt || '',
      flashModel: flashModel,
      flashCheckedAt: escalationSelection && escalationSelection.checkedAtMs ?
        new Date(Number(escalationSelection.checkedAtMs)).toISOString() : ''
    });
  });
  return { refreshed: refreshed };
}

/** Backward-compatible maintenance entrypoint alias. */
function refreshGeminiFlashEscalationModel() {
  return refreshGeminiModelSelectionCaches();
}

function assertGeminiFlashEscalationBudget_(deadlineAt) {
  if (Number(deadlineAt) > 0 &&
    Date.now() + CONFIG.GEMINI_REQUEST_MIN_REMAINING_MS >= Number(deadlineAt)) {
    const error = new Error(
      'Flash escalation model discovery was deferred by the extraction runtime budget.');
    error.extractionEscalationBudgetExhausted = true;
    throw error;
  }
}

function sortFlashLiteModelIds_(models) {
  const versions = {};
  models.forEach(function (model) {
    const normalized = String(model || '');
    if (isStableFlashLiteModelId_(normalized)) {
      versions[normalized] = normalized.replace(/^gemini-/, '')
        .replace(/-flash-lite$/, '').split('.').map(Number);
    }
  });
  return Object.keys(versions).sort(function (left, right) {
    const leftVersion = versions[left];
    const rightVersion = versions[right];
    const length = Math.max(leftVersion.length, rightVersion.length);
    for (let index = 0; index < length; index += 1) {
      const difference = (rightVersion[index] || 0) - (leftVersion[index] || 0);
      if (difference) {
        return difference;
      }
    }
    return left.localeCompare(right);
  });
}

function probeGeminiModelForBackend_(backend, model) {
  const options = Object.assign({
    projectId: getScriptProperty_(CONFIG.PROPERTY_KEYS.GOOGLE_CLOUD_PROJECT_ID),
    geminiApiKey: getScriptProperty_(CONFIG.PROPERTY_KEYS.GEMINI_API_KEY),
    geminiModel: model,
    vertexLocation: getVertexAiLocation_()
  }, arguments.length > 2 && arguments[2] || {}, { geminiModel: model });
  logCatalogEvent_('gemini-model-selection-probe-request', {
    backend: backend,
    model: model,
    requestCount: 1
  });
  let probeResult;
  try {
    if (backend === 'gemini_api') {
      probeResult = validateConfiguredGeminiDeveloperGeneration_(options);
    } else {
      probeResult = validateConfiguredVertexGeneration_(options);
    }
  } catch (error) {
    const status = Number(error && error.geminiProbeHttpStatus ||
      String(error && error.message || error).match(/HTTP ([0-9]{3})/)?.[1] || 0);
    if ([401, 403].indexOf(status) >= 0) {
      error.geminiModelProbeAuthFailure = true;
    } else if ([408, 429, 500, 502, 503, 504].indexOf(status) >= 0) {
      error.geminiModelProbeTransient = true;
    } else {
      error.geminiModelProbeReason = status ? 'provider-rejected-candidate' :
        'generation-readiness-failed';
    }
    logCatalogEvent_('gemini-model-generation-probe', {
      backend: backend,
      model: model,
      successful: false,
      httpStatus: status || undefined,
      finishReason: error && error.geminiProbeFinishReason || 'UNSPECIFIED'
    });
    throw error;
  }
  logCatalogEvent_('gemini-model-generation-probe', {
    backend: backend,
    model: model,
    successful: true,
    modelVersion: probeResult.modelVersion,
    finishReason: probeResult.finishReason,
    promptTokenCount: probeResult.promptTokenCount,
    candidatesTokenCount: probeResult.candidatesTokenCount,
    thoughtsTokenCount: probeResult.thoughtsTokenCount
  });
}

function discoverInstallerGeminiModels_(options) {
  const enabledBackends = [];
  if (options.geminiBackend === 'gemini_api') {
    enabledBackends.push('gemini_api');
  }
  if (options.geminiBackend === 'vertex_ai' || options.autoVertexFallback) {
    enabledBackends.push('vertex_ai');
  }
  const selections = {};
  enabledBackends.forEach(function (backend) {
    const candidates = backend === 'gemini_api' ?
      listGeminiDeveloperFlashLiteCandidates_(options.geminiApiKey) :
      listVertexFlashLiteCandidates_();
    let selectedModel = '';
    const probeOptions = {
      projectId: options.projectId,
      geminiApiKey: options.geminiApiKey,
      vertexLocation: options.vertexLocation
    };
    for (let index = 0; index < candidates.length; index += 1) {
      if (index >= CONFIG.GEMINI_MODEL_SELECTION_MAX_CANDIDATES) {
        break;
      }
      try {
        probeGeminiModelForBackend_(backend, candidates[index], probeOptions);
        selectedModel = candidates[index];
        break;
      } catch (error) {
        if (error && (error.geminiModelProbeAuthFailure === true ||
          error.geminiModelProbeTransient === true)) {
          throw error;
        }
      }
    }
    if (!selectedModel) {
      throw new Error('No GA Flash-Lite candidate passed generation readiness for ' +
        backend + ' during installation.');
    }
    selections[backend] = {
      model: selectedModel,
      candidates: [selectedModel],
      checkedAt: new Date().toISOString(),
      checkedAtMs: Date.now()
    };
  });
  return selections;
}
