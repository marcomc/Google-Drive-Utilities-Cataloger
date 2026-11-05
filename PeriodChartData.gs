// The values in these series are presentation data, never monthly allocations.
// A month coordinate is relative to the year displayed by the original chart:
// January is 1, and January of the following year is 13.
function parsePeriodChartRange_(year, value) {
  const anchorYear = Number(year);
  const text = String(value == null ? '' : value).trim();
  if (!Number.isInteger(anchorYear) || anchorYear < 1900 || anchorYear > 2200) {
    throw new Error('Invalid reference year in chart source.');
  }
  const match = /^(0?[1-9]|1[0-2])(?:\/(\d{4}))?(?:[–-](0?[1-9]|1[0-2])(?:\/(\d{4}))?)?$/.exec(text);
  if (!match || Boolean(match[2]) !== Boolean(match[4]) ||
    (match[2] && Number(match[2]) !== anchorYear)) {
    throw new Error('Invalid reference period in chart source.');
  }
  const start = Number(match[1]);
  const endYear = match[4] ? Number(match[4]) : anchorYear;
  const end = (endYear - anchorYear) * 12 + Number(match[3] || match[1]);
  if (endYear > 2200 || end < start || end - start >= 120) {
    throw new Error('Unsupported reference period in chart source.');
  }
  return { start: start, endExclusive: end + 1, isRange: Boolean(match[3]) };
}

function buildPeriodChartSeries_(year, monthlyValues, periods) {
  if (!Array.isArray(monthlyValues) || monthlyValues.length !== 12 ||
    !Array.isArray(periods)) {
    throw new Error('Invalid chart series data.');
  }
  const points = monthlyValues.map(function (value) {
    if (value === null || value === undefined || value === '' || value === '#N/A') {
      return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('Invalid chart source value.');
    }
    return value;
  });
  const boundaries = {};
  const rangesByStart = {};
  const parsed = periods.map(function (period) { return parsePeriodChartRange_(year, period); });
  const ambiguousStarts = {};
  parsed.forEach(function (range) {
    if (Object.prototype.hasOwnProperty.call(rangesByStart, range.start) &&
      rangesByStart[range.start] !== range.endExclusive) {
      ambiguousStarts[range.start] = true;
    }
    rangesByStart[range.start] = range.endExclusive;
  });
  parsed.forEach(function (range) {
    if (ambiguousStarts[range.start]) {
      // The original monthly point aggregates more than one period. Retain it
      // without inventing an allocation; a later period keeps the existing
      // line continuous. If it is the latest point, review is required.
      if (!parsed.some(function (other) {
        const value = monthlyValues[other.start - 1];
        return other.start > range.start && typeof value === 'number' && Number.isFinite(value);
      })) {
        throw new Error('Conflicting latest chart periods require review.');
      }
      return;
    }
    if (!range.isRange) { return; }
    const source = monthlyValues[range.start - 1];
    if (typeof source !== 'number' || !Number.isFinite(source)) { return; }
    const index = range.endExclusive - 1;
    // A later observed bill takes precedence over an older period's boundary.
    const laterPeriods = parsed.filter(function (other) {
      return other.start > range.start && other.start <= range.endExclusive;
    });
    if (laterPeriods.length) {
      if (!laterPeriods.some(function (other) {
        const value = monthlyValues[other.start - 1];
        return typeof value === 'number' && Number.isFinite(value);
      })) { throw new Error('A later chart period lacks a usable value.'); }
      return;
    }
    if (monthlyValues.slice(range.start, Math.min(index + 1, 12)).some(
      function (value) { return typeof value === 'number' && Number.isFinite(value); }
    )) { return; }
    if (index < 12 && typeof monthlyValues[index] === 'number' &&
      Number.isFinite(monthlyValues[index])) { return; }
    if (Object.prototype.hasOwnProperty.call(boundaries, index) &&
      boundaries[index] !== source) {
      throw new Error('Conflicting chart period boundaries require review.');
    }
    boundaries[index] = source;
  });
  Object.keys(boundaries).forEach(function (index) {
    points[Number(index)] = boundaries[index];
  });
  return Array.from({ length: points.length }, function (_, index) {
    return points[index] === undefined ? null : points[index];
  });
}

function buildPeriodChartTable_(monthLabels, series) {
  if (!Array.isArray(monthLabels) || monthLabels.length !== 12 ||
    monthLabels.some(function (label) { return typeof label !== 'string' || !label; }) ||
    !Array.isArray(series) || !series.length) {
    throw new Error('Invalid chart domain or series.');
  }
  const built = series.map(function (item) {
    return buildPeriodChartSeries_(item.year, item.values, item.periods);
  });
  const rows = Math.max.apply(null, built.map(function (values) { return values.length; }));
  const table = [[''].concat(series.map(function (item) { return item.year; }))];
  for (let index = 0; index < rows; index += 1) {
    const offset = Math.floor(index / 12);
    const label = monthLabels[index % 12] + (offset ? ' (+' + offset + ')' : '');
    table.push([label].concat(built.map(function (values) {
      return values[index] === undefined ? null : values[index];
    })));
  }
  return table;
}

// Work on a copy of the complete Sheets API spec so unrelated options survive.
function addPeriodChartReferencePoints_(spec, size) {
  if (!spec || !spec.basicChart || spec.basicChart.chartType !== 'LINE' ||
    !Array.isArray(spec.basicChart.series) || !Number.isFinite(size) || size <= 0) {
    throw new Error('Expected a line chart and a positive point size.');
  }
  const updated = JSON.parse(JSON.stringify(spec));
  updated.basicChart.series.forEach(function (series) {
    series.pointStyle = Object.assign({}, series.pointStyle || {}, { size: size });
  });
  return updated;
}

// Build a Sheets API update without touching chart identity or overlay position.
// The caller must validate and own the destination block before applying it.
function preparePeriodChartUpdate_(chart, block, pointSize) {
  if (!chart || !Number.isInteger(chart.chartId) || !chart.spec ||
    !block || !Number.isInteger(block.sheetId) ||
    !Number.isInteger(block.startRowIndex) || block.startRowIndex < 0 ||
    !Number.isInteger(block.startColumnIndex) || block.startColumnIndex < 0 ||
    !Number.isInteger(block.rowCount) || block.rowCount < 2) {
    throw new Error('Invalid chart data block.');
  }
  const updated = pointSize !== null && pointSize !== undefined ?
    addPeriodChartReferencePoints_(chart.spec, pointSize) :
    JSON.parse(JSON.stringify(chart.spec));
  const basic = updated.basicChart;
  if (!basic || basic.chartType !== 'LINE' || !Array.isArray(basic.domains) ||
    basic.domains.length !== 1 || !Array.isArray(basic.series) || !basic.series.length) {
    throw new Error('Only line charts with one domain are supported.');
  }
  function source(column) {
    return { sourceRange: { sources: [{ sheetId: block.sheetId,
      startRowIndex: block.startRowIndex,
      endRowIndex: block.startRowIndex + block.rowCount,
      startColumnIndex: block.startColumnIndex + column,
      endColumnIndex: block.startColumnIndex + column + 1 }] } };
  }
  if (!basic.domains[0].domain || basic.series.some(function (series) {
    return !series.series;
  })) { throw new Error('Chart data sources are missing.'); }
  basic.domains[0].domain.sourceRange = source(0).sourceRange;
  basic.series.forEach(function (series, index) {
    series.series.sourceRange = source(index + 1).sourceRange;
  });
  return { updateChartSpec: { chartId: chart.chartId, spec: updated } };
}

// Both requests belong in one Sheets batchUpdate; callers must first prove
// ownership of the reserved block and the identity of the target chart.
function preparePeriodChartBatch_(chart, block, monthLabels, series, pointSize) {
  const table = buildPeriodChartTable_(monthLabels, series);
  if (!block || !Number.isInteger(block.rowCapacity) ||
    !Number.isInteger(block.columnCapacity) || table.length > block.rowCapacity ||
    table[0].length > block.columnCapacity || !chart || !chart.spec ||
    !chart.spec.basicChart || !Array.isArray(chart.spec.basicChart.series) ||
    chart.spec.basicChart.series.length !== series.length) {
    throw new Error('Chart data exceeds its reserved block or series count.');
  }
  const target = Object.assign({}, block, { rowCount: table.length });
  const update = preparePeriodChartUpdate_(chart, target, pointSize);
  const rows = table.map(function (row) {
    return { values: row.map(function (value) {
      if (value === null || value === undefined || value === '') { return {}; }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return { userEnteredValue: { numberValue: value } };
      }
      if (typeof value === 'string' && value.charAt(0) !== '=') {
        return { userEnteredValue: { stringValue: value } };
      }
      throw new Error('Invalid chart data value.');
    }) };
  });
  return [
    { updateCells: { start: { sheetId: block.sheetId,
      rowIndex: block.startRowIndex, columnIndex: block.startColumnIndex },
    rows: rows, fields: 'userEnteredValue' } }, update
  ];
}
