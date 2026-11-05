const PERIOD_CHART_RANGE_PREFIX_ = 'PERIOD_CHART_RANGE_V1_';
const PERIOD_CHART_DATA_MARKER_ = 'gduc.period_chart_data';
const PERIOD_CHART_DATA_ROWS_ = 145;
const PERIOD_CHART_DATA_COLUMNS_ = 26;

function periodChartSheetById_(spreadsheet, sheetId) {
  const found = spreadsheet.getSheets().filter(function (sheet) {
    return sheet.getSheetId() === sheetId;
  });
  if (found.length > 1) { throw new Error('Ambiguous chart sheet identity.'); }
  return found[0] || null;
}

function periodChartTechnicalData_(spreadsheet, registration) {
  const sheet = periodChartSheetById_(spreadsheet, registration.technicalSheetId);
  if (!sheet) { return null; }
  const config = getAutomationConfig_();
  if (sheet.getSheetId() === registration.sheetId ||
    sheet.getSheetId() === registration.sourceSheetId ||
    Object.keys(config.sheet_by_supply || {}).some(function (supply) {
      return config.sheet_by_supply[supply] === sheet.getName();
    }) ||
    sheet.getMaxRows() < PERIOD_CHART_DATA_ROWS_ ||
    sheet.getMaxColumns() < PERIOD_CHART_DATA_COLUMNS_) {
    throw new Error('Invalid period chart data sheet.');
  }
  const markers = sheet.getDeveloperMetadata().filter(function (item) {
    return item.getKey() === PERIOD_CHART_DATA_MARKER_;
  });
  if (markers.length !== 1 || markers[0].getValue() !== registration.marker) {
    throw new Error('Period chart data ownership is missing or ambiguous.');
  }
  const range = sheet.getRange(1, 1, PERIOD_CHART_DATA_ROWS_, PERIOD_CHART_DATA_COLUMNS_);
  if (range.getFormulas().some(function (row) {
    return row.some(function (formula) { return Boolean(formula); });
  })) { throw new Error('Period chart data sheet contains user formulas.'); }
  const chartSheet = periodChartSheetById_(spreadsheet, registration.sheetId);
  if (!chartSheet) { throw new Error('Registered chart source sheet is missing.'); }
  const actualFormats = range.getNumberFormats();
  const formatsMatch = registration.bindings.every(function (binding, index) {
    const formats = chartSheet.getRange(binding.row, binding.column, 13, 1).getNumberFormats();
    return actualFormats.every(function (row, rowIndex) {
      const sourceRow = rowIndex === 0 ? 0 : (rowIndex - 1) % 12 + 1;
      return row[index + 1] === formats[sourceRow][0];
    });
  });
  return { marker: registration.marker, formatsMatch: formatsMatch,
    values: range.getValues().map(function (row) {
        return row.map(function (value) { return value === '' ? null : value; });
      }) };
}

function periodChartFormatRequests_(registration) {
  const requests = [];
  registration.bindings.forEach(function (binding, index) {
    const targetColumn = index + 1;
    [[binding.row - 1, binding.row, 0, 1],
      [binding.row, binding.row + 12, 1, PERIOD_CHART_DATA_ROWS_]].forEach(function (rows) {
      requests.push({ copyPaste: {
        source: { sheetId: registration.sheetId, startRowIndex: rows[0],
          endRowIndex: rows[1], startColumnIndex: binding.column - 1,
          endColumnIndex: binding.column },
        destination: { sheetId: registration.technicalSheetId, startRowIndex: rows[2],
          endRowIndex: rows[3], startColumnIndex: targetColumn,
          endColumnIndex: targetColumn + 1 },
        pasteType: 'PASTE_FORMAT', pasteOrientation: 'NORMAL'
      } });
    });
  });
  return requests;
}

function readPeriodChartSnapshot_(registration) {
  if (!registration || registration.kind !== 'period' ||
    registration.spreadsheetId !== getSpreadsheetId_() ||
    !Number.isInteger(registration.sheetId) || !Number.isInteger(registration.chartId) ||
    !Number.isInteger(registration.technicalSheetId) ||
    !Number.isInteger(registration.sourceSheetId) ||
    !Number.isInteger(registration.columns) || registration.columns < 2 ||
    registration.columns > 26 || typeof registration.marker !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(registration.marker) || !Array.isArray(registration.bindings) ||
    registration.bindings.length !== registration.columns - 1) {
    throw new Error('Invalid period chart registration.');
  }
  const spreadsheet = SpreadsheetApp.openById(registration.spreadsheetId);
  return { chart: readPeriodChart_(registration),
    technical: periodChartTechnicalData_(spreadsheet, registration) };
}

function periodChartSingleRange_(data, sheetId) {
  const sources = data && data.sourceRange && data.sourceRange.sources;
  if (!Array.isArray(sources) || sources.length !== 1) {
    throw new Error('Chart data must use one contiguous source range.');
  }
  const range = sources[0];
  if (range.sheetId !== sheetId || !Number.isInteger(range.startRowIndex) ||
    range.endRowIndex - range.startRowIndex !== 13 ||
    !Number.isInteger(range.startColumnIndex) ||
    range.endColumnIndex - range.startColumnIndex !== 1) {
    throw new Error('Chart does not use a supported monthly source range.');
  }
  return { row: range.startRowIndex + 1, column: range.startColumnIndex + 1 };
}

function periodChartFormulaReferencesSheet_(formula, sheetName) {
  const text = String(formula || '');
  let code = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      if (quoted && text[index + 1] === '"') { index += 1; continue; }
      quoted = !quoted;
      code += ' ';
    } else if (!quoted) { code += text[index]; }
  }
  if (quoted) { return false; }
  const escaped = String(sheetName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedName = "'" + String(sheetName).replace(/'/g, "''") + "'!";
  const escapedQuoted = quotedName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = '(^|[\\s(,;:=+*/^&<>%-])';
  return new RegExp(boundary + escapedQuoted).test(code) ||
    new RegExp(boundary + escaped + '!').test(code);
}

function buildPeriodChartRegistration_(spreadsheet, chart, options, config) {
  const chartSheet = periodChartSheetById_(spreadsheet, options.sheetId);
  const source = periodChartSheetById_(spreadsheet, options.sourceSheetId);
  if (!chartSheet || !source || chartSheet.getSheetId() === source.getSheetId() ||
    Object.keys(config.sheet_by_supply || {}).every(function (supply) {
      return config.sheet_by_supply[supply] !== source.getName();
    })) {
    throw new Error('Period chart source is not a distinct configured supply sheet.');
  }
  const basic = chart.spec && chart.spec.basicChart;
  if (!basic || !chart.nativeState || chart.nativeState.numHeaders !== 1 ||
    basic.chartType !== 'LINE' || basic.headerCount !== 1 ||
    basic.interpolateNulls !== true ||
    !Array.isArray(basic.domains) || basic.domains.length !== 1 ||
    !Array.isArray(basic.series) || !basic.series.length || basic.series.length > 25) {
    throw new Error('Period chart requires one monthly domain and interpolated line series.');
  }
  const domain = periodChartSingleRange_(basic.domains[0].domain, options.sheetId);
  const labels = chartSheet.getRange(domain.row + 1, domain.column, 12, 1)
    .getDisplayValues().map(function (row) { return row[0]; });
  const expected = getLocalizationRegistry_()[config.locale || 'en'].electricityDashboard.months;
  if (labels.some(function (label, index) {
    return String(label).trim().toLowerCase() !== String(expected[index]).trim().toLowerCase();
  })) { throw new Error('Chart domain does not contain the configured monthly labels.'); }
  const bindings = basic.series.map(function (item, index) {
    const range = periodChartSingleRange_(item.series, options.sheetId);
    if (range.row !== domain.row || range.column !== domain.column + index + 1) {
      throw new Error('Chart series must form one contiguous monthly grid.');
    }
    const values = chartSheet.getRange(range.row, range.column, 13, 1).getValues();
    const year = Number(values[0][0]);
    if (!Number.isInteger(year) || year < 1900 || year > 2200) {
      throw new Error('Chart series header is not a supported year.');
    }
    return { year: year, row: range.row, column: range.column };
  });
  if (new Set(bindings.map(function (binding) { return binding.year; })).size !== bindings.length) {
    throw new Error('Chart series years are ambiguous.');
  }
  // Verify that the selected statistics grid actually refers to the chosen
  // supply; chart titles and installation-specific sheet names are not proof.
  const sourceName = source.getName();
  if (!bindings.every(function (binding) {
    const formulas = chartSheet.getRange(domain.row + 1, binding.column, 12, 1).getFormulas();
    return formulas.every(function (row) {
      return periodChartFormulaReferencesSheet_(row[0], sourceName);
    });
  })) { throw new Error('Chart grid does not consistently reference the selected supply sheet.'); }
  const layout = getSheetLayout_(source);
  if (!findHeaderIndex_(layout.lookup, getHeaderAliases_('year')) ||
    !findHeaderIndex_(layout.lookup, getHeaderAliases_('month'))) {
    throw new Error('Period chart source headers are missing.');
  }
  const marker = Utilities.getUuid();
  const sheetId = parseInt(marker.replace(/-/g, '').slice(0, 7), 16) + 1;
  if (periodChartSheetById_(spreadsheet, sheetId) || spreadsheet.getSheets().some(function (sheet) {
    return sheet.getName() === 'GDUC chart ' + marker;
  })) {
    throw new Error('Generated chart data sheet identity is already in use.');
  }
  const allocated = spreadsheet.getSheets().reduce(function (total, sheet) {
    return total + sheet.getMaxRows() * sheet.getMaxColumns();
  }, 0);
  if (allocated + PERIOD_CHART_DATA_ROWS_ * PERIOD_CHART_DATA_COLUMNS_ > 10000000) {
    throw new Error('Insufficient spreadsheet capacity for chart data.');
  }
  return { kind: 'period', spreadsheetId: getSpreadsheetId_(),
    sheetId: options.sheetId, chartId: options.chartId,
    sourceSheetId: options.sourceSheetId, technicalSheetId: sheetId,
    columns: bindings.length + 1, marker: marker, labels: labels, bindings: bindings };
}

function periodChartTableForRegistration_(spreadsheet, registration) {
  const source = periodChartSheetById_(spreadsheet, registration.sourceSheetId);
  const chartSheet = periodChartSheetById_(spreadsheet, registration.sheetId);
  const config = getAutomationConfig_();
  if (!source || !chartSheet || Object.keys(config.sheet_by_supply || {}).every(function (supply) {
    return config.sheet_by_supply[supply] !== source.getName();
  })) { throw new Error('Registered period chart source is no longer configured.'); }
  const layout = getSheetLayout_(source);
  const yearColumn = findHeaderIndex_(layout.lookup, getHeaderAliases_('year'));
  const monthColumn = findHeaderIndex_(layout.lookup, getHeaderAliases_('month'));
  if (!yearColumn || !monthColumn) { throw new Error('Period chart source headers are missing.'); }
  const count = Math.max(0, source.getLastRow() - layout.headerRow);
  const rows = count ? source.getRange(layout.headerRow + 1, 1, count,
    layout.headers.length).getDisplayValues() : [];
  const latestYear = Math.max.apply(null, registration.bindings.map(function (binding) {
    return binding.year;
  }));
  if (rows.some(function (row) {
    const year = Number(row[yearColumn - 1]);
    return Number.isInteger(year) && year > latestYear && year <= 2200 &&
      row[monthColumn - 1] !== '';
  })) {
    throw new Error('A newer source year is not represented by the registered chart.');
  }
  const series = registration.bindings.map(function (binding) {
    const currentHeader = chartSheet.getRange(binding.row, binding.column, 1, 1).getValues()[0][0];
    if (Number(currentHeader) !== binding.year) {
      throw new Error('A registered chart year header changed.');
    }
    const values = chartSheet.getRange(binding.row + 1, binding.column, 12, 1)
      .getValues().map(function (row) { return row[0]; });
    const periods = rows.filter(function (row) {
      return Number(row[yearColumn - 1]) === binding.year && row[monthColumn - 1] !== '';
    }).map(function (row) { return row[monthColumn - 1]; });
    return { year: binding.year, values: values, periods: periods };
  });
  return { series: series, table: buildPeriodChartTable_(registration.labels, series) };
}

function discoverPeriodChartYears_(spreadsheet, registration) {
  const source = periodChartSheetById_(spreadsheet, registration.sourceSheetId);
  const chartSheet = periodChartSheetById_(spreadsheet, registration.sheetId);
  if (!source || !chartSheet) { throw new Error('Registered chart source is missing.'); }
  const layout = getSheetLayout_(source);
  const yearColumn = findHeaderIndex_(layout.lookup, getHeaderAliases_('year'));
  const monthColumn = findHeaderIndex_(layout.lookup, getHeaderAliases_('month'));
  if (!yearColumn || !monthColumn) { throw new Error('Period chart source headers are missing.'); }
  const count = Math.max(0, source.getLastRow() - layout.headerRow);
  const rows = count ? source.getRange(layout.headerRow + 1, 1, count,
    layout.headers.length).getDisplayValues() : [];
  const latest = Math.max.apply(null, registration.bindings.map(function (binding) {
    return binding.year;
  }));
  const years = Array.from(new Set(rows.filter(function (row) {
    const year = Number(row[yearColumn - 1]);
    return Number.isInteger(year) && year > latest && year <= 2200 &&
      row[monthColumn - 1] !== '';
  }).map(function (row) { return Number(row[yearColumn - 1]); }))).sort(function (a, b) {
    return a - b;
  });
  if (!years.length) { return registration; }
  if (registration.bindings.length + years.length >= PERIOD_CHART_DATA_COLUMNS_) {
    throw new Error('Period chart exceeds its reserved year capacity.');
  }
  const last = registration.bindings[registration.bindings.length - 1];
  const added = [];
  let column = last.column + 1;
  let precedingColumn = last.column;
  years.forEach(function (year) {
    if (column > chartSheet.getMaxColumns() ||
      Number(chartSheet.getRange(last.row, column, 1, 1).getValues()[0][0]) !== year) {
      throw new Error('New chart year lacks a verified monthly source grid.');
    }
    const candidate = chartSheet.getRange(last.row + 1, column, 12, 1);
    const formulas = candidate.getFormulas();
    const previousFormulas = chartSheet.getRange(last.row + 1, precedingColumn, 12, 1)
      .getFormulasR1C1();
    if (!formulas.every(function (row) {
      return periodChartFormulaReferencesSheet_(row[0], source.getName());
    }) || JSON.stringify(candidate.getFormulasR1C1()) !== JSON.stringify(previousFormulas)) {
      throw new Error('New chart year lacks a verified monthly source grid.');
    }
    added.push({ year: year, row: last.row, column: column });
    precedingColumn = column;
    column += 1;
  });
  const updated = JSON.parse(JSON.stringify(registration));
  updated.bindings = updated.bindings.concat(added);
  updated.columns = updated.bindings.length + 1;
  return updated;
}

function periodChartPaddedData_(registration, table) {
  if (table.length > PERIOD_CHART_DATA_ROWS_ || table.some(function (row) {
    return row.length !== registration.columns;
  })) { throw new Error('Period chart data exceeds its reservation.'); }
  return Array.from({ length: PERIOD_CHART_DATA_ROWS_ }, function (_, index) {
    const row = table[index] || Array(registration.columns).fill(null);
    return Array.from({ length: PERIOD_CHART_DATA_COLUMNS_ }, function (_, column) {
      const value = row[column];
      return value === '' || value === undefined ? null : value;
    });
  });
}

/** Adopt one explicitly identified monthly chart for billed-period display. */
function adoptCatalogerPeriodChart(options) {
  assertCatalogConfiguration_();
  if (!options || !Number.isInteger(options.sheetId) ||
    !Number.isInteger(options.chartId) || !Number.isInteger(options.sourceSheetId)) {
    throw new Error('Provide chart sheet, chart, and source sheet IDs.');
  }
  return withCatalogLifecycleLock_('period-chart-adoption', function () {
    const recovery = recoverPendingPeriodChartPoints_();
    if (recovery.state === 'uncertain') {
      throw new Error('A chart update has an uncertain result and requires review.');
    }
    const properties = PropertiesService.getScriptProperties();
    const existing = properties.getProperty(PERIOD_CHART_RANGE_PREFIX_ + options.chartId);
    if (existing) {
      const registered = JSON.parse(existing);
      if (registered.kind !== 'period' || registered.chartId !== options.chartId ||
        registered.spreadsheetId !== getSpreadsheetId_() ||
        registered.sheetId !== options.sheetId || registered.sourceSheetId !== options.sourceSheetId) {
        throw new Error('Chart registration conflicts with the requested identity.');
      }
      if (!readPeriodChartSnapshot_(registered).technical) {
        throw new Error('Registered chart data sheet is missing.');
      }
      return { adopted: true, chartId: options.chartId, alreadyRegistered: true };
    }
    const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
    const identity = { spreadsheetId: getSpreadsheetId_(), sheetId: options.sheetId,
      chartId: options.chartId };
    const chart = readPeriodChart_(identity);
    const registration = buildPeriodChartRegistration_(spreadsheet, chart, options,
      getAutomationConfig_());
    const data = periodChartTableForRegistration_(spreadsheet, registration);
    const block = { sheetId: registration.technicalSheetId, startRowIndex: 0,
      startColumnIndex: 0, rowCapacity: PERIOD_CHART_DATA_ROWS_,
      columnCapacity: registration.columns };
    const operations = preparePeriodChartBatch_(chart, block, registration.labels,
      data.series, null);
    const updatedChart = JSON.parse(JSON.stringify(chart));
    updatedChart.spec = operations[1].updateChartSpec.spec;
    const requests = [{ addSheet: { properties: {
      sheetId: registration.technicalSheetId, title: 'GDUC chart ' + registration.marker,
      hidden: true, gridProperties: { rowCount: PERIOD_CHART_DATA_ROWS_,
        columnCount: PERIOD_CHART_DATA_COLUMNS_ } } } },
    { createDeveloperMetadata: { developerMetadata: { metadataKey: PERIOD_CHART_DATA_MARKER_,
      metadataValue: registration.marker, visibility: 'DOCUMENT',
      location: { sheetId: registration.technicalSheetId } } } }]
      .concat(periodChartFormatRequests_(registration), operations);
    const before = periodChartFingerprint_({ chart: chart, technical: null });
    const after = periodChartFingerprint_({ chart: updatedChart, technical: {
      marker: registration.marker, formatsMatch: true,
      values: periodChartPaddedData_(registration, data.table) } });
    commitPeriodChartTransaction_(periodChartPointStore_(properties), periodChartPointSheets_(), {
      version: 1, transactionId: Utilities.getUuid(), spreadsheetId: getSpreadsheetId_(),
      before: before, after: after, registration: registration, requests: requests,
      previousSnapshot: { chart: chart, technical: null }
    });
    return { adopted: true, chartId: options.chartId, alreadyRegistered: false };
  });
}

function refreshRegisteredPeriodChart_(registration) {
  const spreadsheet = SpreadsheetApp.openById(getSpreadsheetId_());
  SpreadsheetApp.flush();
  let beforeSnapshot = readPeriodChartSnapshot_(registration);
  if (!beforeSnapshot.technical) { throw new Error('Registered chart data sheet is missing.'); }
  const chart = beforeSnapshot.chart;
  const basic = chart.spec && chart.spec.basicChart;
  if (!basic || !chart.nativeState || chart.nativeState.numHeaders !== 1 ||
    basic.chartType !== 'LINE' || basic.headerCount !== 1 ||
    basic.interpolateNulls !== true ||
    !Array.isArray(basic.domains) || basic.domains.length !== 1 ||
    !Array.isArray(basic.series) || basic.series.length !== registration.bindings.length) {
    throw new Error('Registered chart layout changed.');
  }
  const chartData = [basic.domains[0].domain].concat(basic.series.map(function (item) {
    return item.series;
  }));
  const sources = chartData.map(function (data) {
    const ranges = data && data.sourceRange && data.sourceRange.sources;
    if (!Array.isArray(ranges) || ranges.length !== 1) {
      throw new Error('Registered chart source is ambiguous.');
    }
    const range = ranges[0];
    if (range.sheetId !== registration.technicalSheetId ||
      !Number.isInteger(range.startRowIndex) || range.startRowIndex < 0 ||
      !Number.isInteger(range.endRowIndex) || range.endRowIndex > PERIOD_CHART_DATA_ROWS_ ||
      range.endRowIndex <= range.startRowIndex ||
      !Number.isInteger(range.startColumnIndex) || range.startColumnIndex < 0 ||
      !Number.isInteger(range.endColumnIndex) || range.endColumnIndex > registration.columns ||
      range.endColumnIndex <= range.startColumnIndex) {
      throw new Error('Registered chart source is outside its managed data block.');
    }
    return range;
  });
  const nextRegistration = discoverPeriodChartYears_(spreadsheet, registration);
  if (nextRegistration !== registration) {
    beforeSnapshot = readPeriodChartSnapshot_(nextRegistration);
  }
  const data = periodChartTableForRegistration_(spreadsheet, nextRegistration);
  const padded = periodChartPaddedData_(nextRegistration, data.table);
  let previousRows = 0;
  beforeSnapshot.technical.values.forEach(function (row, index) {
    if (row.some(function (value) { return value !== null; })) { previousRows = index + 1; }
  });
  const block = { sheetId: registration.technicalSheetId, startRowIndex: 0,
    startColumnIndex: 0, rowCapacity: PERIOD_CHART_DATA_ROWS_,
    columnCapacity: PERIOD_CHART_DATA_COLUMNS_ };
  const updated = JSON.parse(JSON.stringify(chart));
  const addedYears = nextRegistration.bindings.length - registration.bindings.length;
  for (let index = 0; index < addedYears; index += 1) {
    const series = JSON.parse(JSON.stringify(updated.spec.basicChart.series[
      updated.spec.basicChart.series.length - 1]));
    delete series.color;
    delete series.colorStyle;
    const column = registration.bindings.length + index + 1;
    series.series = { sourceRange: { sources: [{ sheetId: registration.technicalSheetId,
      startRowIndex: 0, endRowIndex: data.table.length,
      startColumnIndex: column, endColumnIndex: column + 1 }] } };
    updated.spec.basicChart.series.push(series);
  }
  const operations = preparePeriodChartBatch_(updated, block, registration.labels,
    data.series, null);
  const cellUpdate = operations[0].updateCells;
  while (cellUpdate.rows.length < previousRows) {
    cellUpdate.rows.push({ values: Array.from({ length: nextRegistration.columns }, function () {
      return {};
    }) });
  }
  const updatedSources = [updated.spec.basicChart.domains[0].domain].concat(
    updated.spec.basicChart.series.map(function (item) { return item.series; }));
  let expanded = addedYears > 0;
  updatedSources.forEach(function (dataSource, index) {
    // An owner-adjusted range stays untouched. A range still ending at the
    // previous data boundary grows with a newly extended period.
    if (sources[index] && sources[index].endRowIndex === previousRows && data.table.length > previousRows) {
      dataSource.sourceRange.sources[0].endRowIndex = data.table.length;
      expanded = true;
    }
  });
  const before = periodChartFingerprint_(beforeSnapshot);
  const after = periodChartFingerprint_({ chart: updated, technical: {
    marker: registration.marker, formatsMatch: true, values: padded } });
  if (before === after) { return { state: 'unchanged' }; }
  const requests = beforeSnapshot.technical.formatsMatch ? [] :
    periodChartFormatRequests_(nextRegistration);
  requests.push(operations[0]);
  if (expanded) { requests.push({ updateChartSpec: { chartId: registration.chartId,
    spec: updated.spec } }); }
  return commitPeriodChartTransaction_(periodChartPointStore_(
    PropertiesService.getScriptProperties()), periodChartPointSheets_(), {
    version: 1, transactionId: Utilities.getUuid(), spreadsheetId: getSpreadsheetId_(),
    before: before, after: after, registration: nextRegistration,
    previousSnapshot: { chart: chart, technical: { marker: registration.marker,
      formatsMatch: beforeSnapshot.technical.formatsMatch,
      values: beforeSnapshot.technical.values.slice(0, previousRows).map(function (row) {
        return row.slice(0, registration.columns);
      }) } },
    previousRegistration: addedYears ? registration : null, requests: requests
  });
}

const PERIOD_CHART_REFRESH_PENDING_ = 'PERIOD_CHART_REFRESH_PENDING_V1';

function periodChartRegistrations_(sourceSheetId) {
  const all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all).filter(function (key) {
    return key.indexOf(PERIOD_CHART_RANGE_PREFIX_) === 0;
  }).map(function (key) {
    const registration = JSON.parse(all[key]);
    if (!registration || registration.kind !== 'period' ||
      registration.spreadsheetId !== getSpreadsheetId_() ||
      !Number.isInteger(registration.chartId) || !Number.isInteger(registration.sheetId) ||
      !Number.isInteger(registration.sourceSheetId) ||
      !Number.isInteger(registration.technicalSheetId) ||
      !Array.isArray(registration.bindings) || !Array.isArray(registration.labels) ||
      key !== PERIOD_CHART_RANGE_PREFIX_ + registration.chartId) {
      throw new Error('Invalid stored period chart registration.');
    }
    return registration;
  }).filter(function (registration) {
    return sourceSheetId == null || registration.sourceSheetId === sourceSheetId;
  });
}

function queuePeriodChartRefreshForSource_(sheet) {
  if (!sheet || typeof sheet.getSheetId !== 'function') {
    throw new Error('Period chart source identity is unavailable.');
  }
  if (periodChartRegistrations_(sheet.getSheetId()).length) {
    PropertiesService.getScriptProperties().setProperty(PERIOD_CHART_REFRESH_PENDING_, '1');
  }
}

function refreshPeriodChartsAfterInvoiceImport_(sheet, dashboardResult) {
  const result = refreshPeriodChartsBestEffort_(sheet.getSheetId(), false);
  if (result.state !== 'failed' && result.state !== 'uncertain') { return dashboardResult; }
  const warning = 'Period chart refresh was deferred; imported invoice data was retained.';
  const combined = Object.assign({}, dashboardResult || {});
  combined.warning = [combined.warning, warning].filter(Boolean).join(' ');
  return combined;
}

function refreshPeriodChartsBestEffort_(sourceSheetId, clearPending) {
  const properties = PropertiesService.getScriptProperties();
  try {
    const registrations = periodChartRegistrations_(sourceSheetId);
    if (!registrations.length) {
      if (clearPending) { properties.deleteProperty(PERIOD_CHART_REFRESH_PENDING_); }
      return { state: 'idle' };
    }
    properties.setProperty(PERIOD_CHART_REFRESH_PENDING_, '1');
    const recovered = recoverPendingPeriodChartPoints_();
    if (recovered.state === 'uncertain') { return { state: 'uncertain' }; }
    registrations.forEach(refreshRegisteredPeriodChart_);
    if (clearPending) { properties.deleteProperty(PERIOD_CHART_REFRESH_PENDING_); }
    return { state: 'refreshed' };
  } catch (error) {
    // The marker remains for a later scheduled reconciliation; invoice data is
    // already verified independently and must not be reimported to repair charts.
    logCatalogEvent_('period-chart-refresh-failed', {
      errorType: error.name || 'Error', errorCategory: classifyCatalogErrorForLog_(error)
    });
    return { state: 'failed' };
  }
}

function recoverPendingPeriodChartRefresh_(force) {
  const properties = PropertiesService.getScriptProperties();
  if (!force && !properties.getProperty(PERIOD_CHART_REFRESH_PENDING_)) {
    return { state: 'idle' };
  }
  const prefix = CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX;
  if (Object.keys(properties.getProperties()).some(function (key) {
    return key.indexOf(prefix) === 0;
  })) {
    // Source-row recovery must finish first; otherwise a rollback could leave
    // freshly refreshed charts pointing at an uncommitted invoice state.
    return { state: 'deferred-source-recovery' };
  }
  return refreshPeriodChartsBestEffort_(null, true);
}
