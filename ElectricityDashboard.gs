const ELECTRICITY_DASHBOARD_KEYS_ = Object.freeze([
  'monthlyBands', 'monthlyF1', 'monthlyF2', 'monthlyF3', 'annualBands'
]);
const ELECTRICITY_DASHBOARD_MAX_YEARS_ = 25;
const ELECTRICITY_DASHBOARD_SOURCE_ROWS_ = 10000;

function getElectricityDashboardLabels_(locale) {
  const localization = getLocalizationRegistry_()[locale];
  if (!localization || !localization.electricityDashboard) {
    throw new Error('Unsupported electricity dashboard locale: ' + locale);
  }
  return localization.electricityDashboard;
}

function initializeElectricityDashboard_(spreadsheet, automationConfig) {
  const labels = getElectricityDashboardLabels_(automationConfig.locale || 'en');
  const electricitySheetName = getElectricitySupplySheetName_(automationConfig);
  if (!electricitySheetName) {
    return;
  }
  const electricity = spreadsheet.getSheetByName(electricitySheetName);
  if (!electricity) {
    return;
  }
  if (!validateElectricityDashboardSource_(electricity, labels)) {
    return;
  }
  const dashboard = spreadsheet.getSheetByName(labels.sheet) ||
    spreadsheet.insertSheet(labels.sheet);
  const technical = spreadsheet.getSheetByName(labels.dataSheet) ||
    spreadsheet.insertSheet(labels.dataSheet);
  const chartRanges = writeElectricityDashboardData_(technical, electricity, labels);
  if (!chartRanges) {
    return;
  }
  technical.hideSheet();
  refreshElectricityDashboardCharts_(dashboard, chartRanges, labels);
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

  const blockWidth = ELECTRICITY_DASHBOARD_MAX_YEARS_ + 1;
  const monthlyStarts = [6, 6 + blockWidth + 1, 6 + (blockWidth + 1) * 2];
  const annualStart = monthlyStarts[2] + blockWidth + 1;
  const requiredColumns = annualStart + 3;
  const requiredRows = ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 1;
  ensureElectricityDashboardGrid_(technical, requiredRows, requiredColumns);
  technical.getRange(1, 1, requiredRows, requiredColumns).clearContent();

  writeElectricityMonthlyBandsData_(technical, source, bands, labels);
  bands.forEach(function (band, index) {
    writeElectricityBandComparisonData_(technical, monthlyStarts[index], source,
      band, years, labels);
  });
  writeElectricityAnnualData_(technical, annualStart, source, bands, years,
    labels);

  return {
    monthlyBands: technical.getRange(1, 1,
      ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 1, 4),
    monthlyF1: technical.getRange(1, monthlyStarts[0], 13, blockWidth),
    monthlyF2: technical.getRange(1, monthlyStarts[1], 13, blockWidth),
    monthlyF3: technical.getRange(1, monthlyStarts[2], 13, blockWidth),
    annualBands: technical.getRange(1, annualStart,
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

function refreshElectricityDashboardCharts_(dashboard, chartRanges, labels) {
  const layouts = captureElectricityChartLayouts_(dashboard, labels);
  const managedTitles = ELECTRICITY_DASHBOARD_KEYS_.map(function (key) {
    return labels.charts[key];
  });
  dashboard.getCharts().forEach(function (chart) {
    if (managedTitles.indexOf(String(chart.getOptions().get('title') || '')) >= 0) {
      dashboard.removeChart(chart);
    }
  });
  insertElectricityChart_(dashboard, chartRanges.monthlyBands,
    getElectricityChartLayout_(layouts, 'monthlyBands', 8, 1, 700, 360),
    labels.charts.monthlyBands, 'line');
  insertElectricityChart_(dashboard, chartRanges.monthlyF1,
    getElectricityChartLayout_(layouts, 'monthlyF1', 8, 18, 700, 360),
    labels.charts.monthlyF1, 'column');
  insertElectricityChart_(dashboard, chartRanges.monthlyF2,
    getElectricityChartLayout_(layouts, 'monthlyF2', 28, 18, 700, 360),
    labels.charts.monthlyF2, 'column');
  insertElectricityChart_(dashboard, chartRanges.monthlyF3,
    getElectricityChartLayout_(layouts, 'monthlyF3', 48, 18, 700, 360),
    labels.charts.monthlyF3, 'column');
  insertElectricityChart_(dashboard, chartRanges.annualBands,
    getElectricityChartLayout_(layouts, 'annualBands', 28, 1, 700, 360),
    labels.charts.annualBands, 'column');
}

function captureElectricityChartLayouts_(dashboard, labels) {
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
      row: container.getAnchorRow(),
      column: container.getAnchorColumn(),
      offsetX: container.getOffsetX(),
      offsetY: container.getOffsetY(),
      width: Number(options.get('width')) || 700,
      height: Number(options.get('height')) || 360,
      sourceRanges: chart.getRanges().map(function (range) {
        return range.getA1Notation();
      }),
      options: captureElectricityChartOptions_(options)
    };
  });
  return layouts;
}

function captureElectricityChartOptions_(options) {
  const preserved = {};
  ['colors', 'legend', 'backgroundColor', 'chartArea', 'fontName',
    'hAxis', 'vAxis', 'titleTextStyle'].forEach(function (key) {
    const value = options.get(key);
    if (value !== null && value !== undefined) {
      preserved[key] = value;
    }
  });
  return preserved;
}

function getElectricityChartLayout_(layouts, key, row, column, width, height) {
  return layouts[key] || {
    row: row,
    column: column,
    offsetX: 0,
    offsetY: 0,
    width: width,
    height: height,
    options: {}
  };
}

function insertElectricityChart_(dashboard, sourceRange, layout, title, type) {
  const builder = type === 'line' ? dashboard.newChart().asLineChart() :
    dashboard.newChart().asColumnChart();
  Object.keys(layout.options).forEach(function (key) {
    builder.setOption(key, layout.options[key]);
  });
  dashboard.insertChart(builder.addRange(sourceRange)
    .setNumHeaders(1)
    .setPosition(layout.row, layout.column, layout.offsetX, layout.offsetY)
    .setOption('title', title)
    .setOption('width', layout.width)
    .setOption('height', layout.height)
    .setOption('legend', layout.options.legend || { position: 'right' })
    .build());
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
