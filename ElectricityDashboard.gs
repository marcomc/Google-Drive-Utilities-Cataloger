const ELECTRICITY_DASHBOARD_KEYS_ = Object.freeze([
  'monthlyBands', 'monthlyF1', 'monthlyF2', 'monthlyF3', 'annualBands'
]);
const ELECTRICITY_DASHBOARD_MAX_YEARS_ = 25;
const ELECTRICITY_DASHBOARD_SOURCE_ROWS_ = 10000;
const ELECTRICITY_DASHBOARD_MAX_SPREADSHEET_CELLS_ = 10000000;
const ELECTRICITY_DASHBOARD_NEW_SHEET_ROWS_ = 1000;
const ELECTRICITY_DASHBOARD_NEW_SHEET_COLUMNS_ = 26;
const ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_ =
  'gduc.electricity_dashboard_technical';
const ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_ = 'v1';

function getElectricityDashboardLabels_(locale) {
  const localization = getLocalizationRegistry_()[locale];
  if (!localization || !localization.electricityDashboard) {
    throw new Error('Unsupported electricity dashboard locale: ' + locale);
  }
  return localization.electricityDashboard;
}

function initializeElectricityDashboard_(spreadsheet, automationConfig, options) {
  const labels = getElectricityDashboardLabels_(automationConfig.locale || 'en');
  const electricitySheetName = getElectricitySupplySheetName_(automationConfig);
  if (!electricitySheetName) {
    return;
  }
  const electricity = spreadsheet.getSheetByName(electricitySheetName);
  if (!electricity) {
    return;
  }
  const dashboard = spreadsheet.getSheetByName(labels.sheet);
  const technical = spreadsheet.getSheetByName(labels.dataSheet);
  if (!validateElectricityDashboardSource_(electricity, labels)) {
    if (dashboard || technical) {
      throw new Error('Electricity dashboard source headers are missing or invalid.');
    }
    return;
  }
  if (dashboard === electricity) {
    throw new Error('The electricity dashboard sheet name matches the source sheet.');
  }
  assertElectricityDashboardTechnicalSheet_(technical, electricity, labels);
  assertElectricityDashboardCapacity_(spreadsheet, dashboard, technical);

  let managedDashboard = dashboard;
  let managedTechnical = technical;
  let dashboardCreated = false;
  let technicalCreated = false;
  try {
    if (!managedDashboard) {
      managedDashboard = spreadsheet.insertSheet(labels.sheet);
      dashboardCreated = true;
    }
    if (!managedTechnical) {
      managedTechnical = spreadsheet.insertSheet(labels.dataSheet);
      technicalCreated = true;
    }
    markElectricityDashboardTechnicalSheet_(managedTechnical);
    const chartLayouts = captureElectricityChartLayouts_(managedDashboard,
      managedTechnical, labels);
    const chartRanges = writeElectricityDashboardData_(managedTechnical,
      electricity, labels);
    if (!chartRanges) {
      throw new Error('Electricity dashboard source headers changed during initialization.');
    }
    managedTechnical.hideSheet();
    refreshElectricityDashboardCharts_(managedDashboard, managedTechnical,
      chartRanges, labels, Boolean(options && options.extendManagedRanges),
      chartLayouts);
  } catch (error) {
    if (technicalCreated) {
      spreadsheet.deleteSheet(managedTechnical);
    }
    if (dashboardCreated) {
      spreadsheet.deleteSheet(managedDashboard);
    }
    throw error;
  }
}

function assertElectricityDashboardTechnicalSheet_(technical, electricity,
  labels) {
  if (!technical) {
    return;
  }
  if (technical === electricity) {
    throw new Error('The electricity dashboard technical sheet name matches the source sheet.');
  }
  if (!isManagedElectricityDashboardTechnicalSheet_(technical, labels)) {
    throw new Error('Refusing to overwrite an unmanaged electricity dashboard technical sheet: ' +
      technical.getName());
  }
}

function isManagedElectricityDashboardTechnicalSheet_(sheet, labels) {
  const isMarked = sheet.getDeveloperMetadata().some(function (metadata) {
    return metadata.getKey() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_ &&
      metadata.getValue() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_;
  });
  if (isMarked) {
    return true;
  }
  if (!sheet.isSheetHidden()) {
    return false;
  }
  const headers = sheet.getRange(1, 1, 1, 4).getDisplayValues()[0];
  const expectedHeaders = [labels.dateHeader].concat(labels.bandHeaders);
  const formulas = sheet.getRange(2, 1, 1, 4).getFormulas()[0];
  return expectedHeaders.every(function (header, index) {
    return headers[index] === header;
  }) && formulas.every(function (formula) {
    return /^=ARRAYFORMULA\(/.test(formula);
  });
}

function markElectricityDashboardTechnicalSheet_(sheet) {
  const marked = sheet.getDeveloperMetadata().some(function (metadata) {
    return metadata.getKey() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_ &&
      metadata.getValue() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_;
  });
  if (!marked) {
    sheet.addDeveloperMetadata(ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_,
      ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_);
  }
}

function assertElectricityDashboardCapacity_(spreadsheet, dashboard, technical) {
  const required = getElectricityDashboardTechnicalGrid_();
  const currentCells = spreadsheet.getSheets().reduce(function (total, sheet) {
    return total + sheet.getMaxRows() * sheet.getMaxColumns();
  }, 0);
  const technicalCells = technical ? technical.getMaxRows() *
    technical.getMaxColumns() : 0;
  const finalTechnicalCells = technical ?
    Math.max(technical.getMaxRows(), required.rows) *
      Math.max(technical.getMaxColumns(), required.columns) :
    required.rows * required.columns;
  const dashboardCells = dashboard ? 0 : ELECTRICITY_DASHBOARD_NEW_SHEET_ROWS_ *
    ELECTRICITY_DASHBOARD_NEW_SHEET_COLUMNS_;
  if (currentCells - technicalCells + finalTechnicalCells + dashboardCells >
    ELECTRICITY_DASHBOARD_MAX_SPREADSHEET_CELLS_) {
    throw new Error('Electricity dashboard exceeds the Google Sheets cell limit.');
  }
}

function getElectricityDashboardTechnicalGrid_() {
  const blockWidth = ELECTRICITY_DASHBOARD_MAX_YEARS_ + 1;
  const monthlyStarts = [6, 6 + blockWidth + 1, 6 + (blockWidth + 1) * 2];
  return {
    rows: ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 1,
    columns: monthlyStarts[2] + blockWidth + 4,
    monthlyStarts: monthlyStarts,
    blockWidth: blockWidth,
    annualStart: monthlyStarts[2] + blockWidth + 1
  };
}

function hasElectricityDashboardHeaders_(electricity, labels) {
  const lookup = getSheetLayout_(electricity).lookup;
  const requiredColumns = [
    findHeaderIndex_(lookup, getHeaderAliases_('issueDate')),
    findHeaderIndex_(lookup, getHeaderAliases_('year')),
    findHeaderIndex_(lookup, getHeaderAliases_('month'))
  ];
  labels.bandAliases.forEach(function (aliases) {
    requiredColumns.push(findDashboardHeader_(lookup, aliases));
  });
  return requiredColumns.every(Boolean);
}

function validateElectricityDashboardSource_(electricity, labels) {
  if (!hasElectricityDashboardHeaders_(electricity, labels)) {
    return false;
  }
  const layout = getSheetLayout_(electricity);
  const lookup = layout.lookup;
  const dateColumn = findHeaderIndex_(lookup, getHeaderAliases_('issueDate'));
  const yearColumn = findHeaderIndex_(lookup, getHeaderAliases_('year'));
  if (electricity.getLastRow() > ELECTRICITY_DASHBOARD_SOURCE_ROWS_ +
    layout.headerRow) {
    throw new Error('Electricity dashboard supports up to ' +
      ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + ' source rows.');
  }
  if (getElectricityDashboardYears_(electricity, yearColumn, dateColumn,
    layout.headerRow).length > ELECTRICITY_DASHBOARD_MAX_YEARS_) {
    throw new Error('Electricity dashboard supports up to ' +
      ELECTRICITY_DASHBOARD_MAX_YEARS_ + ' years.');
  }
  return true;
}

function writeElectricityDashboardData_(technical, electricity, labels) {
  const layout = getSheetLayout_(electricity);
  const lookup = layout.lookup;
  const dateColumn = findHeaderIndex_(lookup, getHeaderAliases_('issueDate'));
  const yearColumn = findHeaderIndex_(lookup, getHeaderAliases_('year'));
  const monthColumn = findHeaderIndex_(lookup, getHeaderAliases_('month'));
  const bands = labels.bandAliases.map(function (aliases, index) {
    return { label: 'F' + (index + 1), column: findDashboardHeader_(lookup, aliases) };
  });
  if (!dateColumn || !yearColumn || !monthColumn || bands.some(function (band) {
    return !band.column;
  })) {
    return null;
  }
  if (electricity.getLastRow() > ELECTRICITY_DASHBOARD_SOURCE_ROWS_ +
    layout.headerRow) {
    throw new Error('Electricity dashboard supports up to ' +
      ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + ' source rows.');
  }

  const source = {
    sheet: "'" + electricity.getName().replace(/'/g, "''") + "'!",
    date: columnLetter_(dateColumn),
    year: columnLetter_(yearColumn),
    month: columnLetter_(monthColumn),
    firstDataRow: layout.headerRow + 1,
    lastRow: layout.headerRow + ELECTRICITY_DASHBOARD_SOURCE_ROWS_,
    separator: getSpreadsheetFormulaArgumentSeparator_(technical)
  };
  const years = getElectricityDashboardYears_(electricity, yearColumn, dateColumn,
    layout.headerRow);
  if (years.length > ELECTRICITY_DASHBOARD_MAX_YEARS_) {
    throw new Error('Electricity dashboard supports up to ' +
      ELECTRICITY_DASHBOARD_MAX_YEARS_ + ' years.');
  }

  const grid = getElectricityDashboardTechnicalGrid_();
  ensureElectricityDashboardGrid_(technical, grid.rows, grid.columns);
  technical.getRange(1, 1, grid.rows, grid.columns).clearContent();

  writeElectricityMonthlyBandsData_(technical, source, bands, labels);
  bands.forEach(function (band, index) {
    writeElectricityBandComparisonData_(technical, grid.monthlyStarts[index], source,
      band, years, labels);
  });
  writeElectricityAnnualData_(technical, grid.annualStart, source, bands, years,
    labels);

  return {
    monthlyBands: technical.getRange(1, 1,
      ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 1, 4),
    monthlyF1: technical.getRange(1, grid.monthlyStarts[0], 13, grid.blockWidth),
    monthlyF2: technical.getRange(1, grid.monthlyStarts[1], 13, grid.blockWidth),
    monthlyF3: technical.getRange(1, grid.monthlyStarts[2], 13, grid.blockWidth),
    annualBands: technical.getRange(1, grid.annualStart,
      ELECTRICITY_DASHBOARD_MAX_YEARS_ + 1, 4)
  };
}

function ensureElectricityDashboardGrid_(sheet, requiredRows, requiredColumns) {
  if (sheet.getMaxRows() < requiredRows) {
    sheet.insertRowsAfter(sheet.getMaxRows(), requiredRows - sheet.getMaxRows());
  }
  if (sheet.getMaxColumns() < requiredColumns) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(),
      requiredColumns - sheet.getMaxColumns());
  }
}

function writeElectricityMonthlyBandsData_(technical, source, bands, labels) {
  technical.getRange(1, 1, 1, 4).setValues([[
    labels.dateHeader,
    labels.bandHeaders[0],
    labels.bandHeaders[1],
    labels.bandHeaders[2]
  ]]);
  [source.date, columnLetter_(bands[0].column), columnLetter_(bands[1].column),
    columnLetter_(bands[2].column)].forEach(
    function (column, index) {
      technical.getRange(2, index + 1).setFormula(
        electricitySourceColumnFormula_(source, column)
      );
    }
  );
  technical.getRange(2, 1, ELECTRICITY_DASHBOARD_SOURCE_ROWS_, 1)
    .setNumberFormat('yyyy-mm-dd');
}

function writeElectricityBandComparisonData_(technical, startColumn, source,
  band, years, labels) {
  const values = [[labels.monthHeader].concat(years).concat(
    Array(ELECTRICITY_DASHBOARD_MAX_YEARS_ - years.length).fill(''))];
  labels.months.forEach(function (monthName) {
    values.push([monthName].concat(
      Array(ELECTRICITY_DASHBOARD_MAX_YEARS_).fill('')));
  });
  technical.getRange(1, startColumn, 13,
    ELECTRICITY_DASHBOARD_MAX_YEARS_ + 1).setValues(values);
  if (years.length > 0) {
    const formulas = labels.months.map(function (_, monthIndex) {
      return years.map(function (year) {
        return electricitySumFormula_(source, columnLetter_(band.column), year,
          monthIndex + 1);
      });
    });
    technical.getRange(2, startColumn + 1, labels.months.length, years.length)
      .setFormulas(formulas);
    technical.getRange(1, startColumn + 1, 1, years.length).setNumberFormat('0');
  }
}

function writeElectricityAnnualData_(technical, startColumn, source, bands,
  years, labels) {
  const values = [[labels.yearHeader, 'F1 (kWh)', 'F2 (kWh)', 'F3 (kWh)']];
  years.forEach(function (year) {
    values.push([year, '', '', '']);
  });
  while (values.length <= ELECTRICITY_DASHBOARD_MAX_YEARS_) {
    values.push(['', '', '', '']);
  }
  technical.getRange(1, startColumn, ELECTRICITY_DASHBOARD_MAX_YEARS_ + 1, 4)
    .setValues(values);
  if (years.length > 0) {
    technical.getRange(2, startColumn + 1, years.length, bands.length)
      .setFormulas(years.map(function (year) {
        return bands.map(function (band) {
          return electricityAnnualFormula_(source, columnLetter_(band.column),
            year);
        });
      }));
    technical.getRange(2, startColumn, years.length, 1).setNumberFormat('0');
  }
}

function refreshElectricityDashboardCharts_(dashboard, technical, chartRanges,
  labels, extendManagedRanges, preservedLayouts) {
  const layouts = preservedLayouts || captureElectricityChartLayouts_(dashboard,
    technical, labels);
  const managedTitles = ELECTRICITY_DASHBOARD_KEYS_.map(function (key) {
    return labels.charts[key];
  });
  const managedCharts = dashboard.getCharts().filter(function (chart) {
    return managedTitles.indexOf(String(chart.getOptions().get('title') || '')) >= 0;
  });
  const definitions = [
    ['monthlyBands', chartRanges.monthlyBands, 8, 1, 'line'],
    ['monthlyF1', chartRanges.monthlyF1, 8, 18, 'column'],
    ['monthlyF2', chartRanges.monthlyF2, 28, 18, 'column'],
    ['monthlyF3', chartRanges.monthlyF3, 48, 18, 'column'],
    ['annualBands', chartRanges.annualBands, 28, 1, 'column']
  ];
  const replacements = [];
  const removed = [];
  try {
    definitions.forEach(function (definition) {
      const key = definition[0];
      const chart = buildElectricityChart_(dashboard, technical, definition[1],
        getElectricityChartLayout_(layouts, key, definition[2], definition[3],
          700, 360), labels.charts[key], definition[4], extendManagedRanges);
      dashboard.insertChart(chart);
      replacements.push(chart);
    });
    managedCharts.forEach(function (chart) {
      dashboard.removeChart(chart);
      removed.push(chart);
    });
  } catch (error) {
    replacements.forEach(function (chart) {
      try {
        dashboard.removeChart(chart);
      } catch (cleanupError) {
        console.error('Unable to remove incomplete electricity dashboard chart: ' +
          cleanupError.message);
      }
    });
    removed.forEach(function (chart) {
      try {
        dashboard.insertChart(chart);
      } catch (restoreError) {
        error.mutationRollbackIncomplete = true;
        error.message += ' Chart rollback also failed: ' + restoreError.message;
      }
    });
    throw error;
  }
}

function captureElectricityChartLayouts_(dashboard, technical, labels) {
  const layouts = {};
  dashboard.getCharts().forEach(function (chart) {
    const title = String(chart.getOptions().get('title') || '');
    const key = ELECTRICITY_DASHBOARD_KEYS_.find(function (candidate) {
      return labels.charts[candidate] === title;
    });
    if (!key) {
      return;
    }
    const container = chart.getContainerInfo();
    const options = chart.getOptions();
    layouts[key] = {
      key: key,
      row: container.getAnchorRow(),
      column: container.getAnchorColumn(),
      offsetX: container.getOffsetX(),
      offsetY: container.getOffsetY(),
      width: Number(options.get('width')) || 700,
      height: Number(options.get('height')) || 360,
      sourceRanges: chart.getRanges().filter(function (range) {
        return isElectricityChartRangeWithinManagedBlock_(range, technical, key);
      }).map(function (range) {
        return range.getA1Notation();
      }),
      dataDimension: getElectricityChartDataDimension_(technical, key),
      options: captureElectricityChartOptions_(options)
    };
  });
  return layouts;
}

function isElectricityChartRangeWithinManagedBlock_(range, technical, key) {
  if (range.getSheet().getSheetId() !== technical.getSheetId()) {
    return false;
  }
  const block = getElectricityChartManagedBlock_(key);
  if (!block) {
    return false;
  }
  return range.getRow() >= block.row && range.getColumn() >= block.column &&
    range.getRow() + range.getNumRows() - 1 <= block.row + block.rows - 1 &&
    range.getColumn() + range.getNumColumns() - 1 <=
      block.column + block.columns - 1;
}

function getElectricityChartManagedBlock_(key) {
  const grid = getElectricityDashboardTechnicalGrid_();
  if (key === 'monthlyBands') {
    return { row: 1, column: 1, rows: ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 1,
      columns: 4 };
  }
  if (key === 'annualBands') {
    return { row: 1, column: grid.annualStart,
      rows: ELECTRICITY_DASHBOARD_MAX_YEARS_ + 1, columns: 4 };
  }
  const bandIndex = ELECTRICITY_DASHBOARD_KEYS_.indexOf(key) - 1;
  if (bandIndex < 0 || bandIndex >= grid.monthlyStarts.length) {
    return null;
  }
  return { row: 1, column: grid.monthlyStarts[bandIndex], rows: 13,
    columns: grid.blockWidth };
}

function getElectricityChartDataDimension_(technical, key) {
  const block = getElectricityChartManagedBlock_(key);
  if (!block || key === 'monthlyBands' || typeof technical.getRange !== 'function') {
    return 0;
  }
  const range = key === 'annualBands' ? technical.getRange(block.row,
    block.column, block.rows, 1) : technical.getRange(block.row, block.column,
    1, block.columns);
  if (!range || typeof range.getValues !== 'function') {
    return 0;
  }
  const values = range.getValues();
  const dimension = key === 'annualBands' ? values.map(function (row) {
    return row[0];
  }) : values[0];
  let count = 0;
  for (let index = 0; index < dimension.length; index += 1) {
    if (dimension[index] === '' || dimension[index] === null) {
      return count;
    }
    count += 1;
  }
  return count;
}

function captureElectricityChartOptions_(options) {
  const preserved = {};
  ['annotations', 'areaOpacity', 'backgroundColor', 'bar', 'chartArea',
    'colors', 'curveType', 'dataOpacity', 'enableInteractivity', 'explorer',
    'fontName', 'hAxis', 'height', 'is3D', 'isStacked', 'legend', 'lineWidth',
    'orientation', 'pieHole', 'pieSliceText', 'pointShape', 'pointSize',
    'reverseCategories', 'series', 'theme', 'tooltip', 'trendlines', 'vAxes',
    'vAxis', 'width', 'titleTextStyle', 'animation', 'axisTitlesPosition',
    'crosshair', 'focusTarget', 'histogram', 'intervals', 'selectionMode',
    'slices', 'targetAxisIndex', 'viewWindowMode'].forEach(function (key) {
    const value = options.get(key);
    if (value !== null && value !== undefined) {
      preserved[key] = value;
    }
  });
  return preserved;
}

function getElectricityChartLayout_(layouts, key, row, column, width, height) {
  return layouts[key] || {
    key: key,
    row: row,
    column: column,
    offsetX: 0,
    offsetY: 0,
    width: width,
    height: height,
    options: {}
  };
}

function insertElectricityChart_(dashboard, technical, sourceRange, layout,
  title, type) {
  dashboard.insertChart(buildElectricityChart_(dashboard, technical, sourceRange,
    layout, title, type, false));
}

function buildElectricityChart_(dashboard, technical, sourceRange, layout,
  title, type, extendManagedRanges) {
  const builder = type === 'line' ? dashboard.newChart().asLineChart() :
    dashboard.newChart().asColumnChart();
  Object.keys(layout.options).forEach(function (key) {
    builder.setOption(key, layout.options[key]);
  });
  const ranges = layout.sourceRanges && layout.sourceRanges.length ?
    layout.sourceRanges.map(function (a1Notation) {
      const preserved = technical.getRange(a1Notation);
      return extendManagedRanges &&
        shouldExtendElectricityChartRange_(preserved, sourceRange, technical,
          layout.key, layout.dataDimension) ?
        extendElectricityChartRange_(preserved, technical, layout.key) : preserved;
    }) : [sourceRange];
  ranges.forEach(function (range) {
    builder.addRange(range);
  });
  return builder
    .setNumHeaders(1)
    .setPosition(layout.row, layout.column, layout.offsetX, layout.offsetY)
    .setOption('title', title)
    .setOption('width', layout.width)
    .setOption('height', layout.height)
    .setOption('legend', layout.options.legend || { position: 'right' })
    .build();
}

function shouldExtendElectricityChartRange_(preserved, sourceRange, technical,
  key, previousDimension) {
  if (!preserved || !sourceRange || typeof preserved.getSheet !== 'function' ||
    typeof sourceRange.getSheet !== 'function') {
    return false;
  }
  if (preserved.getSheet().getSheetId() !== sourceRange.getSheet().getSheetId()) {
    return false;
  }
  if (!(preserved.getNumRows() <= sourceRange.getNumRows() &&
    preserved.getNumColumns() <= sourceRange.getNumColumns() &&
    (preserved.getNumRows() < sourceRange.getNumRows() ||
      preserved.getNumColumns() < sourceRange.getNumColumns()))) {
    return false;
  }
  if (!technical || !key || !previousDimension) {
    return false;
  }
  const block = getElectricityChartManagedBlock_(key);
  if (!block || !isElectricityChartRangeWithinManagedBlock_(preserved,
    technical, key)) {
    return false;
  }
  const previousBoundary = key === 'annualBands' ? block.row +
    previousDimension - 1 : block.column + previousDimension - 1;
  const selectedBoundary = key === 'annualBands' ? preserved.getRow() +
    preserved.getNumRows() - 1 : preserved.getColumn() +
    preserved.getNumColumns() - 1;
  return selectedBoundary === previousBoundary &&
    getElectricityChartDataDimension_(technical, key) > previousDimension;
}

function extendElectricityChartRange_(preserved, technical, key) {
  const dimension = getElectricityChartDataDimension_(technical, key);
  const block = getElectricityChartManagedBlock_(key);
  if (key === 'annualBands') {
    const lastRow = block.row + dimension - 1;
    return technical.getRange(preserved.getRow(), preserved.getColumn(),
      lastRow - preserved.getRow() + 1, preserved.getNumColumns());
  }
  const lastColumn = block.column + dimension - 1;
  return technical.getRange(preserved.getRow(), preserved.getColumn(),
    preserved.getNumRows(), lastColumn - preserved.getColumn() + 1);
}

function findDashboardHeader_(lookup, aliases) {
  return findHeaderIndex_(lookup, aliases.map(normalizeHeader_));
}

function columnLetter_(column) {
  let result = '';
  let value = column;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function electricitySourceColumnFormula_(source, column) {
  const range = source.sheet + '$' + column + '$' + source.firstDataRow + ':$' +
    column + '$' + source.lastRow;
  return '=ARRAYFORMULA(IF(' + range + '=""' + source.separator + '""' +
    source.separator + range + '))';
}

function electricitySumFormula_(source, bandColumn, year, month) {
  const bandRange = source.sheet + '$' + bandColumn + '$' + source.firstDataRow +
    ':$' + bandColumn + '$' + source.lastRow;
  const yearRange = source.sheet + '$' + source.year + '$' + source.firstDataRow +
    ':$' + source.year + '$' + source.lastRow;
  const monthRange = source.sheet + '$' + source.month + '$' + source.firstDataRow +
    ':$' + source.month + '$' + source.lastRow;
  return '=SUMIFS(' + bandRange + source.separator + yearRange +
    source.separator + year + source.separator + monthRange +
    source.separator + month + ')';
}

function electricityAnnualFormula_(source, bandColumn, year) {
  const bandRange = source.sheet + '$' + bandColumn + '$' + source.firstDataRow +
    ':$' + bandColumn + '$' + source.lastRow;
  const yearRange = source.sheet + '$' + source.year + '$' + source.firstDataRow +
    ':$' + source.year + '$' + source.lastRow;
  return '=SUMIF(' + yearRange + source.separator + year + source.separator +
    bandRange + ')';
}

function getElectricitySupplySheetName_(automationConfig) {
  const supply = Object.keys(automationConfig.sheet_by_supply || {}).find(
    function (key) {
      return /^(electricity|luce)$/i.test(String(key));
    }
  );
  return supply ? automationConfig.sheet_by_supply[supply] : '';
}

function refreshElectricityDashboardAfterInvoiceImport_(spreadsheet,
  automationConfig, importedSheet, extracted) {
  if (!importedSheet || importedSheet.getName() !==
    getElectricitySupplySheetName_(automationConfig)) {
    return;
  }
  const labels = getElectricityDashboardLabels_(automationConfig.locale || 'en');
  const dashboard = spreadsheet.getSheetByName(labels.sheet);
  const technical = spreadsheet.getSheetByName(labels.dataSheet);
  if (!technical) {
    if (dashboard) {
      throw new Error('Electricity dashboard technical sheet is missing.');
    }
    return;
  }
  if (!isManagedElectricityDashboardTechnicalSheet_(technical, labels)) {
    if (dashboard) {
      throw new Error('Electricity dashboard technical sheet is unmanaged.');
    }
    return;
  }
  // Keep the technical formula reservation authoritative for every electricity
  // import, including an import whose year is already represented in a chart.
  if (!validateElectricityDashboardSource_(importedSheet, labels)) {
    throw new Error('Electricity dashboard source headers are missing or invalid.');
  }
  const year = electricityDashboardImportedYear_(extracted);
  // A replacement can remove a previously represented year, even when its
  // new year is already present. Rebuild on every electricity import so both
  // additions and removals are reflected; expand a narrowed range only when
  // this import adds a new year.
  const extendManagedRanges = Boolean(year) &&
    !hasElectricityDashboardYear_(technical, year);
  try {
    initializeElectricityDashboard_(spreadsheet, automationConfig, {
      extendManagedRanges: extendManagedRanges
    });
  } catch (error) {
    logCatalogEvent_('electricity-dashboard-refresh-failed', {
      errorType: error.name || 'Error',
      errorCategory: classifyCatalogErrorForLog_(error)
    });
    throw error;
  }
}

function electricityDashboardImportedYear_(extracted) {
  const referenceYear = Number(extracted.reference_year);
  if (Number.isInteger(referenceYear) && referenceYear >= 1900 &&
    referenceYear <= 9999) {
    return referenceYear;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(String(extracted.issue_date || '')) ?
    Number(String(extracted.issue_date).slice(0, 4)) : 0;
}

function hasElectricityDashboardYear_(technical, year) {
  const grid = getElectricityDashboardTechnicalGrid_();
  const years = technical.getRange(1, grid.monthlyStarts[0] + 1, 1,
    ELECTRICITY_DASHBOARD_MAX_YEARS_).getValues()[0];
  return years.some(function (candidate) {
    return Number(candidate) === year;
  });
}

function getElectricityDashboardYears_(electricity, yearColumn, dateColumn,
  headerRow) {
  const rowCount = Math.max(1, electricity.getLastRow() - headerRow);
  const years = {};
  const values = electricity.getRange(headerRow + 1, 1, rowCount,
    Math.max(yearColumn, dateColumn)).getValues();
  values.forEach(function (row) {
    const year = electricityDashboardYear_(row[yearColumn - 1],
      row[dateColumn - 1]);
    if (year) {
      years[year] = true;
    }
  });
  const result = Object.keys(years).map(Number).sort(function (a, b) {
    return a - b;
  });
  return result.length ? result : [new Date().getFullYear()];
}

function electricityDashboardYear_(referenceYear, issueDate) {
  const numericYear = Number(referenceYear);
  if (Number.isInteger(numericYear) && numericYear >= 1900 &&
    numericYear <= 9999) {
    return numericYear;
  }
  if (issueDate instanceof Date && !isNaN(issueDate.getTime())) {
    return issueDate.getFullYear();
  }
  return 0;
}
