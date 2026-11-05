const PERIOD_CHART_JOURNAL_KEY_ = 'PERIOD_CHART_POINT_JOURNAL_V1';
const PERIOD_CHART_REGISTRATION_PREFIX_ = 'PERIOD_CHART_POINT_V1_';

function encodePeriodChartJournal_(journal) {
  const serialized = JSON.stringify(journal);
  const blob = Utilities.newBlob(serialized);
  if (blob.getBytes().length > 200000) {
    throw new Error('Chart recovery journal exceeds its maximum size.');
  }
  const stored = blob.getBytes().length <= 8000 ? serialized :
    'gz:' + Utilities.base64Encode(Utilities.gzip(blob).getBytes());
  if (Utilities.newBlob(stored).getBytes().length > 8000) {
    throw new Error('Chart recovery journal exceeds the safe property limit.');
  }
  return stored;
}

function decodePeriodChartJournal_(stored) {
  const serialized = stored.indexOf('gz:') === 0 ?
    Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(stored.slice(3)), 'application/x-gzip'))
      .getDataAsString('UTF-8') : stored;
  if (Utilities.newBlob(serialized).getBytes().length > 200000) {
    throw new Error('Chart recovery journal exceeds its maximum size.');
  }
  return JSON.parse(serialized);
}

function periodChartCanonicalJson_(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(periodChartCanonicalJson_).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + periodChartCanonicalJson_(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function periodChartFingerprint_(value) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    periodChartCanonicalJson_(value), Utilities.Charset.UTF_8).map(function (byte) {
    return ('0' + (byte & 255).toString(16)).slice(-2);
  }).join('');
}

function periodChartPointStore_(properties) {
  return {
    readJournal: function () {
      const raw = properties.getProperty(PERIOD_CHART_JOURNAL_KEY_);
      return raw ? decodePeriodChartJournal_(raw) : null;
    },
    saveJournal: function (journal) {
      properties.setProperty(PERIOD_CHART_JOURNAL_KEY_, encodePeriodChartJournal_(journal));
    },
    saveRegistration: function (registration, previousRegistration) {
      if (!registration || registration.spreadsheetId !== getSpreadsheetId_() ||
        !Number.isInteger(registration.chartId) ||
        !Number.isInteger(registration.sheetId)) {
        throw new Error('Invalid chart registration identity.');
      }
      const key = (registration.kind === 'period' ? 'PERIOD_CHART_RANGE_V1_' :
        PERIOD_CHART_REGISTRATION_PREFIX_) + registration.chartId;
      const previous = properties.getProperty(key);
      const next = JSON.stringify(registration);
      if (previousRegistration && !previous) {
        throw new Error('Previous chart registration is missing.');
      }
      if (previous && previous !== next && (!previousRegistration ||
        previous !== JSON.stringify(previousRegistration))) {
        throw new Error('Chart registration conflicts with existing state.');
      }
      if (previousRegistration && (previousRegistration.kind !== 'period' ||
        previousRegistration.spreadsheetId !== registration.spreadsheetId ||
        previousRegistration.sheetId !== registration.sheetId ||
        previousRegistration.chartId !== registration.chartId ||
        previousRegistration.sourceSheetId !== registration.sourceSheetId ||
        previousRegistration.technicalSheetId !== registration.technicalSheetId ||
        previousRegistration.marker !== registration.marker ||
        !Array.isArray(previousRegistration.bindings) || !Array.isArray(registration.bindings) ||
        registration.bindings.length < previousRegistration.bindings.length ||
        JSON.stringify(registration.bindings.slice(0, previousRegistration.bindings.length)) !==
          JSON.stringify(previousRegistration.bindings) ||
        JSON.stringify(previousRegistration.labels) !== JSON.stringify(registration.labels) ||
        registration.columns !== registration.bindings.length + 1)) {
        throw new Error('Chart registration update changed its identity.');
      }
      properties.setProperty(key, next);
    },
    clearJournal: function () { properties.deleteProperty(PERIOD_CHART_JOURNAL_KEY_); }
  };
}

function periodChartApi_(spreadsheetId, suffix, options) {
  if (spreadsheetId !== getSpreadsheetId_()) {
    throw new Error('Chart spreadsheet identity does not match this installation.');
  }
  const response = UrlFetchApp.fetch('https://sheets.googleapis.com/v4/spreadsheets/' +
    encodeURIComponent(spreadsheetId) + suffix, Object.assign({
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    }, options || {}));
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Chart Sheets request failed with HTTP ' + code + '.');
  }
  return JSON.parse(response.getContentText() || '{}');
}

function readPeriodChart_(registration) {
  if (!registration || registration.spreadsheetId !== getSpreadsheetId_() ||
    !Number.isInteger(registration.chartId) || !Number.isInteger(registration.sheetId)) {
    throw new Error('Invalid chart identity.');
  }
  const result = periodChartApi_(registration.spreadsheetId,
    '?fields=sheets(properties(sheetId),charts(chartId,spec,position))');
  const sheet = (result.sheets || []).filter(function (candidate) {
    return candidate.properties && candidate.properties.sheetId === registration.sheetId;
  });
  if (sheet.length !== 1) { throw new Error('Chart sheet identity is missing or ambiguous.'); }
  const charts = (sheet[0].charts || []).filter(function (chart) {
    return chart.chartId === registration.chartId;
  });
  if (charts.length !== 1 || !charts[0].spec || !charts[0].position) {
    throw new Error('Chart identity is missing or ambiguous.');
  }
  const spreadsheet = SpreadsheetApp.openById(registration.spreadsheetId);
  const nativeSheets = spreadsheet.getSheets().filter(function (candidate) {
    return candidate.getSheetId() === registration.sheetId;
  });
  if (nativeSheets.length !== 1) { throw new Error('Native chart sheet identity is missing.'); }
  const embedded = nativeSheets[0].getCharts().filter(function (chart) {
    return chart.getChartId() === registration.chartId;
  });
  if (embedded.length !== 1) { throw new Error('Native chart identity is missing or ambiguous.'); }
  const native = embedded[0];
  const merge = native.getMergeStrategy();
  const transpose = native.getTransposeRowsAndColumns();
  if (!merge || String(merge) !== String(Charts.ChartMergeStrategy.MERGE_COLUMNS) ||
    transpose !== false) {
    throw new Error('Chart merge or transpose customization is not supported safely.');
  }
  const builder = native.modify();
  const state = { mergeStrategy: String(merge), transposeRowsAndColumns: transpose,
    numHeaders: native.getNumHeaders(),
    hiddenDimensionStrategy: String(native.getHiddenDimensionStrategy()),
    chartType: builder && typeof builder.getChartType === 'function' ?
      String(builder.getChartType()) : null };
  const chart = charts[0];
  chart.nativeState = state;
  return chart;
}

function periodChartPointSheets_() {
  return {
    readFingerprint: function (journal) {
      if (journal.spreadsheetId !== getSpreadsheetId_() || !journal.registration ||
        journal.registration.spreadsheetId !== journal.spreadsheetId) {
        throw new Error('Chart journal spreadsheet identity does not match this installation.');
      }
      return periodChartFingerprint_(journal.registration.kind === 'period' ?
        readPeriodChartSnapshot_(journal.registration) :
        readPeriodChart_(journal.registration));
    },
    applyBatch: function (journal) {
      // Recheck immediately before the write, after the durable checkpoint.
      // A concurrent edit is never knowingly overwritten.
      if (periodChartPointSheets_().readFingerprint(journal) !== journal.before) {
        throw new Error('Chart state changed before the Sheets update.');
      }
      periodChartApi_(journal.spreadsheetId, ':batchUpdate', {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ requests: journal.requests })
      });
      // Refresh SpreadsheetApp's read cache after the separate REST write.
      // Otherwise it can miss a newly created technical sheet in this execution.
      SpreadsheetApp.flush();
    }
  };
}

function recoverPendingPeriodChartPoints_() {
  const store = periodChartPointStore_(PropertiesService.getScriptProperties());
  const result = reconcilePeriodChartTransaction_(store, periodChartPointSheets_());
  if (result.state === 'prepared') {
    // This checkpoint precedes the call to Sheets, so no write was sent.
    store.clearJournal();
    return { state: 'aborted-before-send' };
  }
  return result;
}

// Owner-only maintenance: inspect/reconcile without processing intake files.
// Abandonment requires an explicit operator assertion that the original request
// has terminated; an old-state read alone cannot prove that a timed-out write
// will not finish later. No path here replays a Sheets request.
function recoverCatalogerCharts(options) {
  assertCatalogConfiguration_();
  return withCatalogLifecycleLock_('chart-recovery', function () {
    const properties = PropertiesService.getScriptProperties();
    const store = periodChartPointStore_(properties);
    const result = recoverPendingPeriodChartPoints_();
    if (result.state !== 'uncertain') { return result; }
    const journal = store.readJournal();
    const identity = { state: 'uncertain', transactionId: journal.transactionId,
      before: journal.before, chartId: journal.registration.chartId,
      sheetId: journal.registration.sheetId };
    if (!options) { return identity; }
    if (options.action !== 'abandon' ||
      options.confirmation !== 'NO_WRITE_IN_FLIGHT' ||
      options.transactionId !== journal.transactionId || options.before !== journal.before) {
      throw new Error('Chart recovery requires the exact transaction and operator confirmation.');
    }
    if (periodChartPointSheets_().readFingerprint(journal) !== journal.before) {
      throw new Error('Chart state changed during owner recovery.');
    }
    // Persist the explicit resolution before clearing the blocking journal.
    properties.setProperty('PERIOD_CHART_LAST_RESOLUTION_V1', JSON.stringify({
      transactionId: journal.transactionId, before: journal.before,
      chartId: journal.registration.chartId, sheetId: journal.registration.sheetId,
      resolution: 'abandoned-with-no-write-in-flight', resolvedAt: new Date().toISOString()
    }));
    store.clearJournal();
    return { state: 'abandoned', transactionId: journal.transactionId };
  });
}

function recoverPendingPeriodChartPointsBestEffort_() {
  try {
    const result = recoverPendingPeriodChartPoints_();
    if (result.state === 'uncertain') {
      logCatalogEvent_('chart-point-recovery-deferred', { reason: 'uncertain' });
    }
    return result;
  } catch (error) {
    logCatalogEvent_('chart-point-recovery-failed', {
      errorType: error.name || 'Error',
      errorCategory: classifyCatalogErrorForLog_(error)
    });
    return { state: 'failed' };
  }
}

/** Owner-only adoption of explicitly selected line charts. */
function adoptCatalogerChartPoints(options) {
  assertCatalogConfiguration_();
  if (!options || !Number.isInteger(options.sheetId) ||
    !Array.isArray(options.chartIds) || !options.chartIds.length ||
    options.chartIds.length > 50 || options.chartIds.some(function (id) {
      return !Number.isInteger(id) || id < 0;
    }) || new Set(options.chartIds).size !== options.chartIds.length) {
    throw new Error('Provide one sheet ID and distinct chart IDs.');
  }
  return withCatalogLifecycleLock_('chart-point-adoption', function () {
    const recovery = recoverPendingPeriodChartPoints_();
    if (recovery.state === 'uncertain') {
      throw new Error('A chart update has an uncertain result and requires review.');
    }
    const store = periodChartPointStore_(PropertiesService.getScriptProperties());
    const sheets = periodChartPointSheets_();
    const spreadsheetId = getSpreadsheetId_();
    const adopted = [];
    const properties = PropertiesService.getScriptProperties();
    const candidates = options.chartIds.map(function (chartId) {
      const registration = { spreadsheetId: spreadsheetId,
        sheetId: options.sheetId, chartId: chartId };
      const chart = readPeriodChart_(registration);
      if (!chart.spec.basicChart || chart.spec.basicChart.chartType !== 'LINE' ||
        !Array.isArray(chart.spec.basicChart.series) || !chart.spec.basicChart.series.length) {
        throw new Error('Selected chart is not a line chart with series.');
      }
      const existing = properties.getProperty(PERIOD_CHART_REGISTRATION_PREFIX_ + chartId);
      if (existing && existing !== JSON.stringify(registration)) {
        throw new Error('Chart registration conflicts with existing state.');
      }
      // Validate the largest possible journal before any selected chart changes.
      const maximumJournal = { version: 1, transactionId: Utilities.getUuid(),
        spreadsheetId: spreadsheetId, before: '0'.repeat(64), after: '0'.repeat(64),
        registration: registration, previousChart: chart,
        phase: 'prepared', requests: [{ updateChartSpec: {
          chartId: chartId, spec: addMissingPeriodChartPoints_(chart.spec)
        } }] };
      encodePeriodChartJournal_(maximumJournal);
      return { chartId: chartId, registration: registration, chart: chart };
    });
    candidates.forEach(function (candidate) {
      const chartId = candidate.chartId;
      const registration = candidate.registration;
      const chart = candidate.chart;
      const updated = JSON.parse(JSON.stringify(chart));
      updated.spec = addMissingPeriodChartPoints_(updated.spec);
      const before = periodChartFingerprint_(chart);
      const after = periodChartFingerprint_(updated);
      if (before === after) {
        store.saveRegistration(registration);
      } else {
        commitPeriodChartTransaction_(store, sheets, {
          version: 1, transactionId: Utilities.getUuid(), spreadsheetId: spreadsheetId,
          before: before, after: after, registration: registration,
          previousChart: chart,
          requests: [{ updateChartSpec: { chartId: chartId, spec: updated.spec } }]
        });
      }
      adopted.push(chartId);
    });
    return { adopted: adopted };
  });
}

function addMissingPeriodChartPoints_(spec) {
  const updated = JSON.parse(JSON.stringify(spec));
  updated.basicChart.series.forEach(function (series) {
    const size = series.pointStyle && series.pointStyle.size;
    if (!(typeof size === 'number' && size > 0)) {
      series.pointStyle = Object.assign({}, series.pointStyle || {}, { size: 5 });
    }
  });
  return updated;
}
