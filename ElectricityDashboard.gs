const ELECTRICITY_DASHBOARD_KEYS_ = Object.freeze([
  'monthlyBands', 'monthlyF1', 'monthlyF2', 'monthlyF3', 'annualBands'
]);

function getElectricityDashboardLabels_(locale) {
  if (locale === 'it') {
    return {
      sheet: 'Statistiche Luce',
      dataSheet: 'Statistiche Luce - Dati',
      months: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
        'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
      charts: {
        monthlyBands: 'Consumi mensili per fascia (F1/F2/F3)',
        monthlyF1: 'Confronto mensile consumi F1 per anno',
        monthlyF2: 'Confronto mensile consumi F2 per anno',
        monthlyF3: 'Confronto mensile consumi F3 per anno',
        annualBands: 'Consumo annuale per fascia'
      }
    };
  }
  return {
    sheet: 'Electricity Statistics',
    dataSheet: 'Electricity Statistics - Data',
    months: ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'],
    charts: {
      monthlyBands: 'Monthly consumption by band (F1/F2/F3)',
      monthlyF1: 'Monthly F1 consumption by year',
      monthlyF2: 'Monthly F2 consumption by year',
      monthlyF3: 'Monthly F3 consumption by year',
      annualBands: 'Annual consumption by band'
    }
  };
}

function initializeElectricityDashboard_(spreadsheet, automationConfig) {
  const labels = getElectricityDashboardLabels_(automationConfig.locale || 'en');
  const luceName = getElectricitySupplySheetName_(automationConfig);
  if (!luceName) {
    return;
  }
  const luce = spreadsheet.getSheetByName(luceName);
  if (!luce) {
    return;
  }
  const dashboard = spreadsheet.getSheetByName(labels.sheet) ||
    spreadsheet.insertSheet(labels.sheet);
  const technical = spreadsheet.getSheetByName(labels.dataSheet) ||
    spreadsheet.insertSheet(labels.dataSheet);
  technical.hideSheet();
  writeElectricityDashboardData_(technical, luce, labels);
  refreshElectricityDashboardCharts_(dashboard, technical, labels);
}

function writeElectricityDashboardData_(technical, luce, labels) {
  const layout = getSheetLayout_(luce);
  const lookup = layout.lookup;
  const dateColumn = findHeaderIndex_(lookup, getHeaderAliases_('issueDate'));
  const yearColumn = findHeaderIndex_(lookup, getHeaderAliases_('year'));
  const monthColumn = findHeaderIndex_(lookup, getHeaderAliases_('month'));
  const bands = [
    { label: 'F1', column: findDashboardHeader_(lookup, ['quantità consumi f1']) },
    { label: 'F2', column: findDashboardHeader_(lookup, ['quantità consumi f2']) },
    { label: 'F3', column: findDashboardHeader_(lookup, ['quantità consumi f3']) }
  ];
  if (!dateColumn || !yearColumn || !monthColumn || bands.some(function (band) {
    return !band.column;
  })) {
    return;
  }
  const source = {
    sheet: "'" + luce.getName().replace(/'/g, "''") + "'!",
    year: columnLetter_(yearColumn),
    month: columnLetter_(monthColumn)
  };
  technical.clear();
  technical.getRange(1, 1, 1, 41).clear({ contentsOnly: true });
  const years = getElectricityDashboardYears_(luce, dateColumn);
  const monthNames = labels.months;
  bands.forEach(function (band, bandIndex) {
    const startColumn = bandIndex * 10 + 1;
    const rows = [['Mese'].concat(years)];
    monthNames.forEach(function (monthName, monthIndex) {
      const row = [monthName];
      years.forEach(function (year) {
        row.push(electricitySumFormula_(source, columnLetter_(band.column), year, monthIndex + 1));
      });
      rows.push(row);
    });
    technical.getRange(1, startColumn, rows.length, rows[0].length).setValues(
      rows.map(function (row) { return row.map(function (value) { return typeof value === 'string' && value.charAt(0) === '=' ? null : value; }); })
    );
    rows.forEach(function (row, rowIndex) {
      row.forEach(function (value, columnIndex) {
        if (typeof value === 'string' && value.charAt(0) === '=') {
          technical.getRange(rowIndex + 1, startColumn + columnIndex).setFormula(value);
        }
      });
    });
  });
  const annualStart = 31;
  const annualRows = [['Anno', 'F1 (kWh)', 'F2 (kWh)', 'F3 (kWh)']];
  years.forEach(function (year, index) {
    annualRows.push([year,
      electricityAnnualFormula_(source, columnLetter_(bands[0].column), year),
      electricityAnnualFormula_(source, columnLetter_(bands[1].column), year),
      electricityAnnualFormula_(source, columnLetter_(bands[2].column), year)]);
  });
  technical.getRange(1, annualStart, annualRows.length, 4).setValues(
    annualRows.map(function (row) { return row.map(function (value) { return typeof value === 'string' && value.charAt(0) === '=' ? null : value; }); })
  );
  annualRows.forEach(function (row, rowIndex) {
    row.forEach(function (value, columnIndex) {
      if (typeof value === 'string' && value.charAt(0) === '=') {
        technical.getRange(rowIndex + 1, annualStart + columnIndex).setFormula(value);
      }
    });
  });
  technical.getRange(1, 2, 1, years.length).setNumberFormat('0');
  technical.getRange(1, 32, years.length + 1, 1).setNumberFormat('0');
}

function refreshElectricityDashboardCharts_(dashboard, technical, labels) {
  const layouts = captureElectricityChartLayouts_(dashboard, labels);
  const managedTitles = ELECTRICITY_DASHBOARD_KEYS_.map(function (key) {
    return labels.charts[key];
  });
  dashboard.getCharts().forEach(function (chart) {
    if (managedTitles.indexOf(String(chart.getOptions().get('title') || '')) >= 0) {
      dashboard.removeChart(chart);
    }
  });
  insertElectricityChart_(dashboard, technical.getRange('A1:I13'),
    getElectricityChartLayout_(layouts, 'monthlyBands', 8, 1, 700, 360),
    labels.charts.monthlyBands, 'line');
  insertElectricityChart_(dashboard, technical.getRange('A1:I13'),
    getElectricityChartLayout_(layouts, 'monthlyF1', 8, 18, 700, 360),
    labels.charts.monthlyF1, 'column');
  insertElectricityChart_(dashboard, technical.getRange('K1:S13'),
    getElectricityChartLayout_(layouts, 'monthlyF2', 28, 18, 700, 360),
    labels.charts.monthlyF2, 'column');
  insertElectricityChart_(dashboard, technical.getRange('U1:AC13'),
    getElectricityChartLayout_(layouts, 'monthlyF3', 48, 18, 700, 360),
    labels.charts.monthlyF3, 'column');
  insertElectricityChart_(dashboard, technical.getRange('AE1:AH9'),
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
      height: Number(options.get('height')) || 360
    };
  });
  return layouts;
}

function getElectricityChartLayout_(layouts, key, row, column, width, height) {
  return layouts[key] || { row: row, column: column, offsetX: 0, offsetY: 0, width: width, height: height };
}

function insertElectricityChart_(dashboard, sourceRange, layout, title, type) {
  const builder = type === 'line' ? dashboard.newChart().asLineChart() : dashboard.newChart().asColumnChart();
  dashboard.insertChart(builder.addRange(sourceRange)
    .setNumHeaders(1)
    .setPosition(layout.row, layout.column, layout.offsetX, layout.offsetY)
    .setOption('title', title)
    .setOption('width', layout.width)
    .setOption('height', layout.height)
    .setOption('legend', { position: 'right' })
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

function electricitySumFormula_(source, bandColumn, year, month) {
  return '=SUMIFS(' + source.sheet + '$' + bandColumn + '$3:$' + bandColumn + '$1002,' + source.sheet + '$' +
    source.year + '$3:$' + source.year + '$1002,' + year + ',' + source.sheet + '$' + source.month +
    '$3:$' + source.month + '$1002,' + month + ')';
}

function electricityAnnualFormula_(source, bandColumn, year) {
  return '=SUMIF(' + source.sheet + '$' + source.year + '$3:$' + source.year + '$1002,' + year +
    ',' + source.sheet + '$' + bandColumn + '$3:$' + bandColumn + '$1002)';
}

function getElectricitySupplySheetName_(automationConfig) {
  const supply = Object.keys(automationConfig.sheet_by_supply).find(function (key) {
    return /^(electricity|luce)$/i.test(String(key));
  });
  return supply ? automationConfig.sheet_by_supply[supply] : '';
}

function getElectricityDashboardYears_(luce, dateColumn) {
  const values = luce.getRange(3, dateColumn, Math.max(1, luce.getLastRow() - 2), 1).getValues();
  const years = {};
  values.forEach(function (row) {
    if (row[0] instanceof Date && !isNaN(row[0].getTime())) {
      years[row[0].getFullYear()] = true;
    }
  });
  const result = Object.keys(years).map(Number).sort(function (a, b) { return a - b; });
  return result.length ? result : [new Date().getFullYear()];
}
