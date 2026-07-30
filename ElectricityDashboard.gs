const ELECTRICITY_DASHBOARD_KEYS_ = Object.freeze([
  'monthlyBands', 'monthlyF1', 'monthlyF2', 'monthlyF3', 'annualBands'
]);
const ELECTRICITY_DASHBOARD_MAX_YEARS_ = 25;
const ELECTRICITY_DASHBOARD_SOURCE_ROWS_ = 10000;
const ELECTRICITY_DASHBOARD_MAX_SPREADSHEET_CELLS_ = 10000000;
const ELECTRICITY_DASHBOARD_NEW_SHEET_ROWS_ = 1000;
const ELECTRICITY_DASHBOARD_NEW_SHEET_COLUMNS_ = 26;
const ELECTRICITY_DASHBOARD_METADATA_KEY_ =
  'gduc.electricity_dashboard';
const ELECTRICITY_DASHBOARD_METADATA_VALUE_ = 'v1';
const ELECTRICITY_DASHBOARD_CREATION_VERSION_ = 1;
const ELECTRICITY_DASHBOARD_CREATION_MAX_AGE_MS_ =
  24 * 60 * 60 * 1000;
const ELECTRICITY_DASHBOARD_STAGING_PREFIX_ =
  'Electricity dashboard pending ';
const ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_ =
  'gduc.electricity_dashboard_technical';
const ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_ = 'v1';
const ELECTRICITY_DASHBOARD_TECHNICAL_CREATION_VERSION_ = 1;
const ELECTRICITY_DASHBOARD_TECHNICAL_CREATION_MAX_AGE_MS_ =
  24 * 60 * 60 * 1000;
const ELECTRICITY_DASHBOARD_TECHNICAL_STAGING_PREFIX_ =
  'Electricity dashboard technical pending ';
const ELECTRICITY_DASHBOARD_BACKUP_ROWS_ =
  ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 3 * 13 +
  ELECTRICITY_DASHBOARD_MAX_YEARS_ + 2;
const ELECTRICITY_DASHBOARD_BACKUP_COLUMNS_ = 26;
const ELECTRICITY_DASHBOARD_BACKUP_PREFIX_ =
  'Electricity dashboard backup ';
const ELECTRICITY_DASHBOARD_BACKUP_METADATA_KEY_ =
  'gduc.electricity_dashboard_backup';
const ELECTRICITY_DASHBOARD_BACKUP_METADATA_VALUE_ = 'v1';
const ELECTRICITY_DASHBOARD_BACKUP_CREATION_VERSION_ = 1;
const ELECTRICITY_DASHBOARD_BACKUP_CREATION_MAX_AGE_MS_ =
  24 * 60 * 60 * 1000;
const ELECTRICITY_DASHBOARD_BACKUP_STAGING_PREFIX_ =
  ELECTRICITY_DASHBOARD_BACKUP_PREFIX_ + 'pending ';

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
  const displayedDashboard = spreadsheet.getSheetByName(labels.sheet);
  let technical = spreadsheet.getSheetByName(labels.dataSheet);
  if (!validateElectricityDashboardSource_(electricity, labels)) {
    if (displayedDashboard || technical) {
      throw new Error('Electricity dashboard source headers are missing or invalid.');
    }
    return;
  }
  const dashboardCreation = reconcileElectricityDashboardCreation_(
    spreadsheet, labels);
  let dashboard = dashboardCreation.sheet || displayedDashboard;
  if (dashboardCreation.sheet && displayedDashboard &&
    dashboardCreation.sheet.getSheetId() !== displayedDashboard.getSheetId()) {
    throw new Error('The electricity dashboard creation record does not match ' +
      'the target sheet.');
  }
  if (dashboard && Object.keys(automationConfig.sheet_by_supply || {}).some(
    function (supply) {
      return spreadsheet.getSheetByName(
        automationConfig.sheet_by_supply[supply]
      ) === dashboard;
    })) {
    throw new Error('The electricity dashboard sheet name matches a source sheet.');
  }
  const dashboardOwnership = assertElectricityDashboardSheetOwnership_(
    dashboard, technical, labels);
  const technicalCreation = reconcileElectricityDashboardTechnicalCreation_(
    spreadsheet, labels);
  if (technicalCreation.sheet) {
    if (technical && technical.getSheetId() !==
      technicalCreation.sheet.getSheetId()) {
      throw new Error('The electricity dashboard technical creation record ' +
        'does not match the target sheet.');
    }
    technical = technicalCreation.sheet;
  }
  if (technical && Object.keys(automationConfig.sheet_by_supply || {}).some(
    function (supply) {
      return spreadsheet.getSheetByName(
        automationConfig.sheet_by_supply[supply]
      ) === technical;
    })) {
    throw new Error('The electricity dashboard technical sheet name matches a source sheet.');
  }
  assertElectricityDashboardTechnicalSheet_(technical, electricity, labels);
  if (dashboardOwnership === 'legacy') {
    ensureElectricityDashboardSheetOwnership_(dashboard, technical, labels);
  }
  const technicalBackupCreation =
    reconcileElectricityDashboardTechnicalBackups_(spreadsheet, technical);
  const technicalRecoveredFromCreation = technicalCreation.recovered;
  const willCreateTechnicalBackup =
    Boolean(technical && !technicalRecoveredFromCreation);
  assertElectricityDashboardCapacity_(spreadsheet, dashboard, technical,
    willCreateTechnicalBackup);

  let managedDashboard = dashboard;
  let managedTechnical = technical;
  let dashboardCreated = false;
  let technicalCreated = technicalRecoveredFromCreation;
  let technicalBackup = null;
  try {
    if (!managedDashboard) {
      managedDashboard = createElectricityDashboardSheet_(spreadsheet, labels,
        dashboardCreation.journal);
      dashboardCreated = true;
    }
    if (!managedTechnical) {
      managedTechnical = createElectricityDashboardTechnicalSheet_(spreadsheet,
        labels, technicalCreation.journal);
      technicalCreated = true;
    }
    markElectricityDashboardTechnicalSheet_(managedTechnical);
    if (willCreateTechnicalBackup) {
      const grid = getElectricityDashboardTechnicalGrid_();
      ensureElectricityDashboardGrid_(managedTechnical, grid.rows, grid.columns);
      technicalBackup = createElectricityDashboardTechnicalBackup_(spreadsheet,
        managedTechnical, technicalBackupCreation.journal);
    }
    const chartLayouts = mergeElectricityChartLayouts_(
      captureElectricityChartLayouts_(managedDashboard, managedTechnical, labels),
      options && options.preservedLayouts
    );
    const chartRanges = writeElectricityDashboardData_(managedTechnical,
      electricity, labels);
    if (!chartRanges) {
      throw new Error('Electricity dashboard source headers changed during initialization.');
    }
    managedTechnical.hideSheet();
    refreshElectricityDashboardCharts_(managedDashboard, managedTechnical,
      chartRanges, labels, Boolean(options && options.extendManagedRanges),
      chartLayouts);
    if (technicalBackup) {
      spreadsheet.deleteSheet(technicalBackup.sheet);
      technicalBackup = null;
      clearElectricityDashboardTechnicalBackupCreation_();
    }
  } catch (error) {
    if (technicalBackup) {
      try {
        restoreElectricityDashboardTechnicalBackup_(technicalBackup,
          managedTechnical);
      } catch (restoreError) {
        error.mutationRollbackIncomplete = true;
        error.message += ' Technical data rollback also failed: ' +
          restoreError.message;
      }
      try {
        spreadsheet.deleteSheet(technicalBackup.sheet);
        technicalBackup = null;
        clearElectricityDashboardTechnicalBackupCreation_();
      } catch (cleanupError) {
        error.mutationRollbackIncomplete = true;
        error.message += ' Technical backup cleanup also failed: ' +
          cleanupError.message;
      }
    }
    if (technicalCreated) {
      try {
        spreadsheet.deleteSheet(managedTechnical);
      } catch (cleanupError) {
        error.mutationRollbackIncomplete = true;
        error.message += ' Technical sheet cleanup also failed: ' +
          cleanupError.message;
      }
    }
    if (dashboardCreated) {
      try {
        spreadsheet.deleteSheet(managedDashboard);
      } catch (cleanupError) {
        error.mutationRollbackIncomplete = true;
        error.message += ' Dashboard sheet cleanup also failed: ' +
          cleanupError.message;
      }
    }
    throw error;
  }
}

function reconcileElectricityDashboardCreation_(spreadsheet, labels) {
  const properties = PropertiesService.getScriptProperties();
  const propertyKey = CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_CREATION;
  const raw = properties.getProperty(propertyKey);
  if (!raw) {
    return { sheet: null, journal: null, recovered: false };
  }

  const journal = parseElectricityDashboardCreation_(raw, spreadsheet, labels);
  const sheets = spreadsheet.getSheets();
  const target = spreadsheet.getSheetByName(journal.targetName);
  if (target && (journal.state !== 'created' ||
    target.getSheetId() !== journal.sheetId)) {
    throw new Error('The electricity dashboard creation record does not match ' +
      'the target sheet.');
  }

  let sheet = null;
  if (journal.state === 'created') {
    sheet = sheets.find(function (candidate) {
      return candidate.getSheetId() === journal.sheetId;
    });
    if (!sheet) {
      throw new Error('The electricity dashboard creation record references a ' +
        'missing sheet.');
    }
    assertElectricityDashboardCreationSheet_(sheet, journal, true);
  } else {
    const staged = sheets.filter(function (candidate) {
      return candidate.getName() === journal.stagingName;
    });
    if (staged.length > 1) {
      throw new Error('The electricity dashboard creation record matches ' +
        'multiple sheets.');
    }
    if (staged.length === 0) {
      return { sheet: null, journal: journal, recovered: false };
    }
    sheet = staged[0];
    assertElectricityDashboardCreationSheet_(sheet, journal, false);
    journal.state = 'created';
    journal.sheetId = sheet.getSheetId();
    writeElectricityDashboardCreation_(properties, journal);
  }

  finalizeElectricityDashboardCreation_(properties, sheet, journal);
  return { sheet: sheet, journal: null, recovered: true };
}

function createElectricityDashboardSheet_(spreadsheet, labels, existingJournal) {
  const properties = PropertiesService.getScriptProperties();
  const journal = existingJournal ||
    planElectricityDashboardCreation_(properties, spreadsheet, labels);
  if (spreadsheet.getSheetByName(journal.targetName) ||
    spreadsheet.getSheetByName(journal.stagingName)) {
    throw new Error('The electricity dashboard creation target or staging name ' +
      'is already occupied.');
  }
  const sheet = spreadsheet.insertSheet(journal.stagingName);
  journal.state = 'created';
  journal.sheetId = sheet.getSheetId();
  writeElectricityDashboardCreation_(properties, journal);
  assertElectricityDashboardCreationSheet_(sheet, journal, false);
  finalizeElectricityDashboardCreation_(properties, sheet, journal);
  return sheet;
}

function planElectricityDashboardCreation_(properties, spreadsheet, labels) {
  const stagingName = ELECTRICITY_DASHBOARD_STAGING_PREFIX_ +
    Utilities.getUuid();
  if (spreadsheet.getSheetByName(labels.sheet) ||
    spreadsheet.getSheetByName(stagingName)) {
    throw new Error('The electricity dashboard creation target or staging name ' +
      'is already occupied.');
  }
  const journal = {
    version: ELECTRICITY_DASHBOARD_CREATION_VERSION_,
    state: 'planned',
    spreadsheetId: spreadsheet.getId(),
    targetName: labels.sheet,
    stagingName: stagingName,
    plannedAt: new Date().getTime(),
    existingSheetIds: spreadsheet.getSheets().map(function (sheet) {
      return sheet.getSheetId();
    })
  };
  writeElectricityDashboardCreation_(properties, journal);
  return journal;
}

function parseElectricityDashboardCreation_(raw, spreadsheet, labels) {
  let journal;
  try {
    journal = JSON.parse(raw);
  } catch (error) {
    throw new Error('The electricity dashboard creation record is malformed.');
  }
  const validSheetIds = Array.isArray(journal && journal.existingSheetIds) &&
    journal.existingSheetIds.every(function (sheetId, index, sheetIds) {
      return isValidElectricityDashboardSheetId_(sheetId) &&
        sheetIds.indexOf(sheetId) === index;
    });
  const validBase = journal &&
    journal.version === ELECTRICITY_DASHBOARD_CREATION_VERSION_ &&
    (journal.state === 'planned' || journal.state === 'created') &&
    typeof journal.spreadsheetId === 'string' && journal.spreadsheetId &&
    typeof journal.targetName === 'string' && journal.targetName &&
    typeof journal.stagingName === 'string' &&
    journal.stagingName.indexOf(ELECTRICITY_DASHBOARD_STAGING_PREFIX_) === 0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(journal.stagingName.substring(
        ELECTRICITY_DASHBOARD_STAGING_PREFIX_.length)) &&
    typeof journal.plannedAt === 'number' && isFinite(journal.plannedAt) &&
    journal.plannedAt > 0 && Math.floor(journal.plannedAt) === journal.plannedAt &&
    validSheetIds;
  const validState = journal && (journal.state === 'planned' ?
    typeof journal.sheetId === 'undefined' :
    isValidElectricityDashboardSheetId_(journal.sheetId) &&
      journal.existingSheetIds.indexOf(journal.sheetId) < 0);
  if (!validBase || !validState) {
    throw new Error('The electricity dashboard creation record is malformed.');
  }
  const age = new Date().getTime() - journal.plannedAt;
  if (age < -5 * 60 * 1000 ||
    age > ELECTRICITY_DASHBOARD_CREATION_MAX_AGE_MS_) {
    throw new Error('The electricity dashboard creation record is stale.');
  }
  if (journal.spreadsheetId !== spreadsheet.getId() ||
    journal.targetName !== labels.sheet) {
    throw new Error('The electricity dashboard creation record does not match ' +
      'this spreadsheet.');
  }
  return journal;
}

function assertElectricityDashboardCreationSheet_(sheet, journal,
  allowInitialized) {
  if (journal.existingSheetIds.indexOf(sheet.getSheetId()) >= 0 ||
    (sheet.getName() !== journal.stagingName &&
      sheet.getName() !== journal.targetName) ||
    (journal.state === 'created' && sheet.getSheetId() !== journal.sheetId)) {
    throw new Error('The electricity dashboard creation record does not match ' +
      'the created sheet.');
  }
  const metadata = sheet.getDeveloperMetadata();
  const ownershipMetadata =
    getElectricityDashboardOwnershipMetadataState_(sheet);
  const pristine = sheet.getName() === journal.stagingName &&
    sheet.getMaxRows() === ELECTRICITY_DASHBOARD_NEW_SHEET_ROWS_ &&
    sheet.getMaxColumns() === ELECTRICITY_DASHBOARD_NEW_SHEET_COLUMNS_ &&
    sheet.getLastRow() === 0 && sheet.getLastColumn() === 0 &&
    !sheet.isSheetHidden() && sheet.getFrozenRows() === 0 &&
    sheet.getFrozenColumns() === 0 && sheet.getCharts().length === 0 &&
    sheet.getDrawings().length === 0 && metadata.length === 0;
  if (!ownershipMetadata.safe || (!allowInitialized && !pristine)) {
    throw new Error('The electricity dashboard creation record does not ' +
      'identify a safe created sheet.');
  }
}

function finalizeElectricityDashboardCreation_(properties, sheet, journal) {
  const target = sheet.getParent().getSheetByName(journal.targetName);
  if (target && target.getSheetId() !== sheet.getSheetId()) {
    throw new Error('The electricity dashboard creation target is occupied.');
  }
  markElectricityDashboardSheet_(sheet);
  if (!isElectricityDashboardSheetMarked_(sheet)) {
    throw new Error('The electricity dashboard ownership marker was not persisted.');
  }
  if (sheet.getName() !== journal.targetName) {
    sheet.setName(journal.targetName);
  }
  const verifiedTarget = sheet.getParent().getSheetByName(journal.targetName);
  if (sheet.getName() !== journal.targetName || !verifiedTarget ||
    verifiedTarget.getSheetId() !== sheet.getSheetId() ||
    !isElectricityDashboardSheetMarked_(verifiedTarget)) {
    throw new Error('The electricity dashboard target identity was not persisted.');
  }
  properties.deleteProperty(CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_CREATION);
}

function writeElectricityDashboardCreation_(properties, journal) {
  properties.setProperty(CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_CREATION,
    JSON.stringify(journal));
}

function ensureElectricityDashboardSheetOwnership_(dashboard, technical,
  labels) {
  const ownership = assertElectricityDashboardSheetOwnership_(dashboard,
    technical, labels);
  if (ownership !== 'legacy') {
    return;
  }
  markElectricityDashboardSheet_(dashboard);
  if (!isElectricityDashboardSheetMarked_(dashboard)) {
    throw new Error('The electricity dashboard ownership marker was not persisted.');
  }
}

function assertElectricityDashboardSheetOwnership_(dashboard, technical,
  labels) {
  if (!dashboard) {
    return 'absent';
  }
  assertSafeElectricityDashboardOwnershipMetadata_(dashboard);
  if (isElectricityDashboardSheetMarked_(dashboard)) {
    return 'marked';
  }
  if (!isExactLegacyElectricityDashboard_(dashboard, technical, labels)) {
    throw new Error('Refusing to overwrite an unmanaged electricity dashboard ' +
      'sheet: ' + dashboard.getName());
  }
  return 'legacy';
}

function isExactLegacyElectricityDashboard_(dashboard, technical, labels) {
  const ownershipMetadata =
    getElectricityDashboardOwnershipMetadataState_(dashboard);
  if (!ownershipMetadata.safe ||
    ownershipMetadata.dashboardMarkers.length !== 0 || !technical ||
    !isManagedElectricityDashboardTechnicalSheet_(technical, labels) ||
    typeof dashboard.getCharts !== 'function') {
    return false;
  }
  const charts = dashboard.getCharts();
  return ELECTRICITY_DASHBOARD_KEYS_.every(function (key) {
    const matches = charts.filter(function (chart) {
      return String(chart.getOptions().get('title') || '') === labels.charts[key];
    });
    return matches.length === 1 && matches[0].getRanges().length > 0 &&
      matches[0].getRanges().every(function (range) {
        return isElectricityChartRangeWithinManagedBlock_(range, technical, key);
      });
  });
}

function isElectricityDashboardSheetMarked_(sheet) {
  if (!sheet || typeof sheet.getDeveloperMetadata !== 'function') {
    return false;
  }
  const ownershipMetadata =
    getElectricityDashboardOwnershipMetadataState_(sheet);
  return ownershipMetadata.safe &&
    ownershipMetadata.dashboardMarkers.length === 1;
}

function markElectricityDashboardSheet_(sheet) {
  const ownershipMetadata =
    assertSafeElectricityDashboardOwnershipMetadata_(sheet);
  if (ownershipMetadata.dashboardMarkers.length === 0) {
    sheet.addDeveloperMetadata(ELECTRICITY_DASHBOARD_METADATA_KEY_,
      ELECTRICITY_DASHBOARD_METADATA_VALUE_);
  }
}

function getElectricityDashboardOwnershipMetadataState_(sheet) {
  if (!sheet || typeof sheet.getDeveloperMetadata !== 'function') {
    return { safe: false, dashboardMarkers: [] };
  }
  const metadata = sheet.getDeveloperMetadata();
  const dashboardMarkers = metadata.filter(function (item) {
    return item.getKey() === ELECTRICITY_DASHBOARD_METADATA_KEY_;
  });
  const conflictingManagedMarker = metadata.some(function (item) {
    return item.getKey() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_ ||
      item.getKey() === ELECTRICITY_DASHBOARD_BACKUP_METADATA_KEY_;
  });
  const validDashboardMarkers = dashboardMarkers.every(function (item) {
    return item.getValue() === ELECTRICITY_DASHBOARD_METADATA_VALUE_;
  });
  return {
    safe: !conflictingManagedMarker && dashboardMarkers.length <= 1 &&
      validDashboardMarkers,
    dashboardMarkers: dashboardMarkers
  };
}

function assertSafeElectricityDashboardOwnershipMetadata_(sheet) {
  const ownershipMetadata =
    getElectricityDashboardOwnershipMetadataState_(sheet);
  if (!ownershipMetadata.safe) {
    throw new Error('The electricity dashboard ownership metadata is ' +
      'conflicting or malformed.');
  }
  return ownershipMetadata;
}

function reconcileElectricityDashboardTechnicalCreation_(spreadsheet, labels) {
  const properties = PropertiesService.getScriptProperties();
  const propertyKey =
    CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_TECHNICAL_CREATION;
  const raw = properties.getProperty(propertyKey);
  if (!raw) {
    return { sheet: null, journal: null, recovered: false };
  }

  const journal = parseElectricityDashboardTechnicalCreation_(raw,
    spreadsheet, labels);
  const sheets = spreadsheet.getSheets();
  const target = spreadsheet.getSheetByName(journal.targetName);
  if (target && (journal.state !== 'created' ||
    target.getSheetId() !== journal.sheetId)) {
    throw new Error('The electricity dashboard technical creation record ' +
      'does not match the target sheet.');
  }

  let sheet = null;
  if (journal.state === 'created') {
    sheet = sheets.find(function (candidate) {
      return candidate.getSheetId() === journal.sheetId;
    });
    if (!sheet) {
      throw new Error('The electricity dashboard technical creation record ' +
        'references a missing sheet.');
    }
    assertElectricityDashboardTechnicalCreationSheet_(sheet, journal, true);
  } else {
    const staged = sheets.filter(function (candidate) {
      return candidate.getName() === journal.stagingName;
    });
    if (staged.length > 1) {
      throw new Error('The electricity dashboard technical creation record ' +
        'matches multiple sheets.');
    }
    if (staged.length === 0) {
      return { sheet: null, journal: journal, recovered: false };
    }
    sheet = staged[0];
    assertElectricityDashboardTechnicalCreationSheet_(sheet, journal, false);
    journal.state = 'created';
    journal.sheetId = sheet.getSheetId();
    writeElectricityDashboardTechnicalCreation_(properties, journal);
  }

  finalizeElectricityDashboardTechnicalCreation_(properties, sheet, journal);
  return { sheet: sheet, journal: null, recovered: true };
}

function createElectricityDashboardTechnicalSheet_(spreadsheet, labels,
  existingJournal) {
  const properties = PropertiesService.getScriptProperties();
  const journal = existingJournal ||
    planElectricityDashboardTechnicalCreation_(properties, spreadsheet, labels);
  const sheet = spreadsheet.insertSheet(journal.stagingName);
  journal.state = 'created';
  journal.sheetId = sheet.getSheetId();
  writeElectricityDashboardTechnicalCreation_(properties, journal);
  assertElectricityDashboardTechnicalCreationSheet_(sheet, journal, false);
  finalizeElectricityDashboardTechnicalCreation_(properties, sheet, journal);
  return sheet;
}

function planElectricityDashboardTechnicalCreation_(properties, spreadsheet,
  labels) {
  const existingSheetIds = spreadsheet.getSheets().map(function (sheet) {
    return sheet.getSheetId();
  });
  const journal = {
    version: ELECTRICITY_DASHBOARD_TECHNICAL_CREATION_VERSION_,
    state: 'planned',
    spreadsheetId: spreadsheet.getId(),
    targetName: labels.dataSheet,
    stagingName: ELECTRICITY_DASHBOARD_TECHNICAL_STAGING_PREFIX_ +
      Utilities.getUuid(),
    plannedAt: new Date().getTime(),
    existingSheetIds: existingSheetIds
  };
  writeElectricityDashboardTechnicalCreation_(properties, journal);
  return journal;
}

function parseElectricityDashboardTechnicalCreation_(raw, spreadsheet, labels) {
  let journal;
  try {
    journal = JSON.parse(raw);
  } catch (error) {
    throw new Error('The electricity dashboard technical creation record is malformed.');
  }
  const validSheetIds = Array.isArray(journal && journal.existingSheetIds) &&
    journal.existingSheetIds.every(function (sheetId, index, sheetIds) {
      return isValidElectricityDashboardSheetId_(sheetId) &&
        sheetIds.indexOf(sheetId) === index;
    });
  const validBase = journal &&
    journal.version === ELECTRICITY_DASHBOARD_TECHNICAL_CREATION_VERSION_ &&
    (journal.state === 'planned' || journal.state === 'created') &&
    typeof journal.spreadsheetId === 'string' && journal.spreadsheetId &&
    typeof journal.targetName === 'string' && journal.targetName &&
    typeof journal.stagingName === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(journal.stagingName.substring(
        ELECTRICITY_DASHBOARD_TECHNICAL_STAGING_PREFIX_.length)) &&
    journal.stagingName.indexOf(
      ELECTRICITY_DASHBOARD_TECHNICAL_STAGING_PREFIX_) === 0 &&
    typeof journal.plannedAt === 'number' && isFinite(journal.plannedAt) &&
    journal.plannedAt > 0 && Math.floor(journal.plannedAt) === journal.plannedAt &&
    validSheetIds;
  const validState = journal && (journal.state === 'planned' ?
    typeof journal.sheetId === 'undefined' :
    isValidElectricityDashboardSheetId_(journal.sheetId) &&
      journal.existingSheetIds.indexOf(journal.sheetId) < 0);
  if (!validBase || !validState) {
    throw new Error('The electricity dashboard technical creation record is malformed.');
  }
  const age = new Date().getTime() - journal.plannedAt;
  if (age < -5 * 60 * 1000 ||
    age > ELECTRICITY_DASHBOARD_TECHNICAL_CREATION_MAX_AGE_MS_) {
    throw new Error('The electricity dashboard technical creation record is stale.');
  }
  if (journal.spreadsheetId !== spreadsheet.getId() ||
    journal.targetName !== labels.dataSheet) {
    throw new Error('The electricity dashboard technical creation record ' +
      'does not match this spreadsheet.');
  }
  return journal;
}

function isValidElectricityDashboardSheetId_(sheetId) {
  return typeof sheetId === 'number' && isFinite(sheetId) &&
    sheetId >= 0 && Math.floor(sheetId) === sheetId;
}

function assertElectricityDashboardTechnicalCreationSheet_(sheet, journal,
  allowOwnershipMarker) {
  if (journal.existingSheetIds.indexOf(sheet.getSheetId()) >= 0 ||
    (sheet.getName() !== journal.stagingName &&
      sheet.getName() !== journal.targetName)) {
    throw new Error('The electricity dashboard technical creation record ' +
      'does not match the created sheet.');
  }
  const metadata = sheet.getDeveloperMetadata();
  const hasOwnership = metadata.some(function (item) {
    return item.getKey() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_ &&
      item.getValue() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_;
  });
  const validMetadata = metadata.length === 0 ||
    allowOwnershipMarker && hasOwnership && metadata.every(function (item) {
      return item.getKey() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_ &&
        item.getValue() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_;
    });
  const pristine = sheet.getMaxRows() ===
      ELECTRICITY_DASHBOARD_NEW_SHEET_ROWS_ &&
    sheet.getMaxColumns() === ELECTRICITY_DASHBOARD_NEW_SHEET_COLUMNS_ &&
    sheet.getLastRow() === 0 && sheet.getLastColumn() === 0 &&
    !sheet.isSheetHidden() && sheet.getFrozenRows() === 0 &&
    sheet.getFrozenColumns() === 0 && sheet.getCharts().length === 0 &&
    sheet.getDrawings().length === 0 && validMetadata;
  if (!pristine || sheet.getName() === journal.targetName && !hasOwnership) {
    throw new Error('The electricity dashboard technical creation record ' +
      'does not identify a pristine created sheet.');
  }
}

function finalizeElectricityDashboardTechnicalCreation_(properties, sheet,
  journal) {
  const target = sheet.getParent().getSheetByName(journal.targetName);
  if (target && target.getSheetId() !== sheet.getSheetId()) {
    throw new Error('The electricity dashboard technical creation target is occupied.');
  }
  markElectricityDashboardTechnicalSheet_(sheet);
  if (!isElectricityDashboardTechnicalSheetMarked_(sheet)) {
    throw new Error('The electricity dashboard technical sheet ownership ' +
      'marker was not persisted.');
  }
  if (sheet.getName() !== journal.targetName) {
    sheet.setName(journal.targetName);
  }
  properties.deleteProperty(
    CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_TECHNICAL_CREATION);
}

function writeElectricityDashboardTechnicalCreation_(properties, journal) {
  properties.setProperty(
    CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_TECHNICAL_CREATION,
    JSON.stringify(journal));
}

function getElectricityDashboardTechnicalDataBlocks_(sheet) {
  const grid = getElectricityDashboardTechnicalGrid_();
  return [
    { row: 1, column: 1, rows: ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 1,
      columns: 4, backupRow: 1 },
    { row: 1, column: grid.monthlyStarts[0], rows: 13,
      columns: grid.blockWidth, backupRow: ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 2 },
    { row: 1, column: grid.monthlyStarts[1], rows: 13,
      columns: grid.blockWidth, backupRow: ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 15 },
    { row: 1, column: grid.monthlyStarts[2], rows: 13,
      columns: grid.blockWidth, backupRow: ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 28 },
    { row: 1, column: grid.annualStart,
      rows: ELECTRICITY_DASHBOARD_MAX_YEARS_ + 1, columns: 4,
      backupRow: ELECTRICITY_DASHBOARD_SOURCE_ROWS_ + 41 }
  ];
}

function createElectricityDashboardTechnicalBackup_(spreadsheet, technical,
  existingJournal) {
  assertElectricityDashboardBackupCapacity_(spreadsheet);
  const properties = PropertiesService.getScriptProperties();
  const journal = existingJournal ||
    planElectricityDashboardTechnicalBackupCreation_(properties, spreadsheet,
      technical);
  if (journal.technicalSheetId !== technical.getSheetId()) {
    throw new Error('The electricity dashboard technical backup creation ' +
      'record does not match the technical sheet.');
  }

  let backup = null;
  try {
    backup = spreadsheet.insertSheet(journal.stagingName);
    journal.state = 'created';
    journal.sheetId = backup.getSheetId();
    writeElectricityDashboardTechnicalBackupCreation_(properties, journal);
    assertElectricityDashboardTechnicalBackupCreationSheet_(backup, journal,
      false);
    markElectricityDashboardTechnicalBackup_(backup);
    if (!isElectricityDashboardTechnicalBackup_(backup)) {
      throw new Error('The electricity dashboard technical backup ownership ' +
        'marker was not persisted.');
    }
    ensureElectricityDashboardGrid_(backup, ELECTRICITY_DASHBOARD_BACKUP_ROWS_,
      ELECTRICITY_DASHBOARD_BACKUP_COLUMNS_);
    const blocks = getElectricityDashboardTechnicalDataBlocks_(technical);
    blocks.forEach(function (block) {
      technical.getRange(block.row, block.column, block.rows, block.columns)
        .copyTo(backup.getRange(block.backupRow, 1, block.rows, block.columns));
    });
    backup.hideSheet();
    return { sheet: backup, blocks: blocks };
  } catch (error) {
    if (backup) {
      try {
        spreadsheet.deleteSheet(backup);
        backup = null;
        clearElectricityDashboardTechnicalBackupCreation_();
      } catch (cleanupError) {
        error.mutationRollbackIncomplete = true;
        error.message += ' Technical backup cleanup also failed: ' +
          cleanupError.message;
      }
    }
    throw error;
  }
}

function reconcileElectricityDashboardTechnicalBackups_(spreadsheet,
  technical) {
  const properties = PropertiesService.getScriptProperties();
  const propertyKey =
    CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_TECHNICAL_BACKUP_CREATION;
  const raw = properties.getProperty(propertyKey);
  let pendingJournal = null;
  if (raw) {
    const journal = parseElectricityDashboardTechnicalBackupCreation_(raw,
      spreadsheet, technical);
    const sheets = spreadsheet.getSheets();
    if (journal.state === 'created') {
      const created = sheets.find(function (sheet) {
        return sheet.getSheetId() === journal.sheetId;
      });
      if (created) {
        assertElectricityDashboardTechnicalBackupCreationSheet_(created,
          journal, true);
        spreadsheet.deleteSheet(created);
      }
      properties.deleteProperty(propertyKey);
    } else {
      const staged = sheets.filter(function (sheet) {
        return sheet.getName() === journal.stagingName;
      });
      if (staged.length > 1) {
        throw new Error('The electricity dashboard technical backup creation ' +
          'record matches multiple sheets.');
      }
      if (staged.length === 0) {
        pendingJournal = journal;
      } else {
        assertElectricityDashboardTechnicalBackupCreationSheet_(staged[0],
          journal, false);
        journal.state = 'created';
        journal.sheetId = staged[0].getSheetId();
        writeElectricityDashboardTechnicalBackupCreation_(properties, journal);
        spreadsheet.deleteSheet(staged[0]);
        properties.deleteProperty(propertyKey);
      }
    }
  }

  spreadsheet.getSheets().filter(function (sheet) {
    return isElectricityDashboardTechnicalBackup_(sheet);
  }).forEach(function (backup) {
    spreadsheet.deleteSheet(backup);
  });
  return { journal: pendingJournal };
}

function planElectricityDashboardTechnicalBackupCreation_(properties,
  spreadsheet, technical) {
  if (!isElectricityDashboardTechnicalSheetMarked_(technical)) {
    throw new Error('Refusing to create an electricity dashboard technical ' +
      'backup for an unmarked technical sheet.');
  }
  const stagingName = ELECTRICITY_DASHBOARD_BACKUP_STAGING_PREFIX_ +
    Utilities.getUuid();
  if (spreadsheet.getSheetByName(stagingName)) {
    throw new Error('The electricity dashboard technical backup staging name ' +
      'is already occupied.');
  }
  const journal = {
    version: ELECTRICITY_DASHBOARD_BACKUP_CREATION_VERSION_,
    state: 'planned',
    spreadsheetId: spreadsheet.getId(),
    technicalSheetId: technical.getSheetId(),
    stagingName: stagingName,
    plannedAt: new Date().getTime(),
    existingSheetIds: spreadsheet.getSheets().map(function (sheet) {
      return sheet.getSheetId();
    })
  };
  writeElectricityDashboardTechnicalBackupCreation_(properties, journal);
  return journal;
}

function parseElectricityDashboardTechnicalBackupCreation_(raw, spreadsheet,
  technical) {
  let journal;
  try {
    journal = JSON.parse(raw);
  } catch (error) {
    throw new Error('The electricity dashboard technical backup creation ' +
      'record is malformed.');
  }
  const validSheetIds = Array.isArray(journal && journal.existingSheetIds) &&
    journal.existingSheetIds.every(function (sheetId, index, sheetIds) {
      return isValidElectricityDashboardSheetId_(sheetId) &&
        sheetIds.indexOf(sheetId) === index;
    });
  const validBase = journal &&
    journal.version === ELECTRICITY_DASHBOARD_BACKUP_CREATION_VERSION_ &&
    (journal.state === 'planned' || journal.state === 'created') &&
    typeof journal.spreadsheetId === 'string' && journal.spreadsheetId &&
    isValidElectricityDashboardSheetId_(journal.technicalSheetId) &&
    typeof journal.stagingName === 'string' &&
    journal.stagingName.indexOf(ELECTRICITY_DASHBOARD_BACKUP_STAGING_PREFIX_) ===
      0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(journal.stagingName.substring(
        ELECTRICITY_DASHBOARD_BACKUP_STAGING_PREFIX_.length)) &&
    typeof journal.plannedAt === 'number' && isFinite(journal.plannedAt) &&
    journal.plannedAt > 0 && Math.floor(journal.plannedAt) === journal.plannedAt &&
    validSheetIds &&
    journal.existingSheetIds.indexOf(journal.technicalSheetId) >= 0;
  const validState = journal && (journal.state === 'planned' ?
    typeof journal.sheetId === 'undefined' :
    isValidElectricityDashboardSheetId_(journal.sheetId) &&
      journal.existingSheetIds.indexOf(journal.sheetId) < 0);
  if (!validBase || !validState) {
    throw new Error('The electricity dashboard technical backup creation ' +
      'record is malformed.');
  }
  const age = new Date().getTime() - journal.plannedAt;
  if (age < -5 * 60 * 1000 ||
    age > ELECTRICITY_DASHBOARD_BACKUP_CREATION_MAX_AGE_MS_) {
    throw new Error('The electricity dashboard technical backup creation ' +
      'record is stale.');
  }
  if (journal.spreadsheetId !== spreadsheet.getId() || !technical ||
    journal.technicalSheetId !== technical.getSheetId() ||
    !isElectricityDashboardTechnicalSheetMarked_(technical)) {
    throw new Error('The electricity dashboard technical backup creation ' +
      'record does not match this spreadsheet and technical sheet.');
  }
  return journal;
}

function assertElectricityDashboardTechnicalBackupCreationSheet_(sheet,
  journal, allowPartialBackup) {
  if (journal.existingSheetIds.indexOf(sheet.getSheetId()) >= 0 ||
    sheet.getName() !== journal.stagingName ||
    (journal.state === 'created' && sheet.getSheetId() !== journal.sheetId)) {
    throw new Error('The electricity dashboard technical backup creation ' +
      'record does not match the created sheet.');
  }
  const metadata = sheet.getDeveloperMetadata();
  const validMetadata = metadata.length === 0 || (allowPartialBackup &&
    metadata.every(function (item) {
      return item.getKey() === ELECTRICITY_DASHBOARD_BACKUP_METADATA_KEY_ &&
        item.getValue() === ELECTRICITY_DASHBOARD_BACKUP_METADATA_VALUE_;
    }));
  const pristine = sheet.getMaxRows() ===
      ELECTRICITY_DASHBOARD_NEW_SHEET_ROWS_ &&
    sheet.getMaxColumns() === ELECTRICITY_DASHBOARD_NEW_SHEET_COLUMNS_ &&
    sheet.getLastRow() === 0 && sheet.getLastColumn() === 0 &&
    !sheet.isSheetHidden() && sheet.getFrozenRows() === 0 &&
    sheet.getFrozenColumns() === 0 && sheet.getCharts().length === 0 &&
    sheet.getDrawings().length === 0 && validMetadata;
  if (!validMetadata || (!allowPartialBackup && !pristine)) {
    throw new Error('The electricity dashboard technical backup creation ' +
      'record does not identify a safe created sheet.');
  }
}

function writeElectricityDashboardTechnicalBackupCreation_(properties,
  journal) {
  properties.setProperty(
    CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_TECHNICAL_BACKUP_CREATION,
    JSON.stringify(journal));
}

function clearElectricityDashboardTechnicalBackupCreation_() {
  PropertiesService.getScriptProperties().deleteProperty(
    CONFIG.PROPERTY_KEYS.ELECTRICITY_DASHBOARD_TECHNICAL_BACKUP_CREATION);
}

function isElectricityDashboardTechnicalBackup_(sheet) {
  return sheet && typeof sheet.getDeveloperMetadata === 'function' &&
    sheet.getDeveloperMetadata().some(function (metadata) {
      return metadata.getKey() === ELECTRICITY_DASHBOARD_BACKUP_METADATA_KEY_ &&
        metadata.getValue() === ELECTRICITY_DASHBOARD_BACKUP_METADATA_VALUE_;
    });
}

function markElectricityDashboardTechnicalBackup_(sheet) {
  sheet.addDeveloperMetadata(ELECTRICITY_DASHBOARD_BACKUP_METADATA_KEY_,
    ELECTRICITY_DASHBOARD_BACKUP_METADATA_VALUE_);
}

function restoreElectricityDashboardTechnicalBackup_(backup, technical) {
  backup.blocks.forEach(function (block) {
    backup.sheet.getRange(block.backupRow, 1, block.rows, block.columns)
      .copyTo(technical.getRange(block.row, block.column, block.rows,
        block.columns));
  });
}

function assertElectricityDashboardBackupCapacity_(spreadsheet) {
  const currentCells = spreadsheet.getSheets().reduce(function (total, sheet) {
    return total + sheet.getMaxRows() * sheet.getMaxColumns();
  }, 0);
  if (currentCells + ELECTRICITY_DASHBOARD_BACKUP_ROWS_ *
    ELECTRICITY_DASHBOARD_BACKUP_COLUMNS_ >
    ELECTRICITY_DASHBOARD_MAX_SPREADSHEET_CELLS_) {
    throw new Error('Electricity dashboard backup exceeds the Google Sheets cell limit.');
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
  if (isElectricityDashboardTechnicalSheetMarked_(sheet)) {
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

function isElectricityDashboardTechnicalSheetMarked_(sheet) {
  return sheet.getDeveloperMetadata().some(function (metadata) {
    return metadata.getKey() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_ &&
      metadata.getValue() === ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_;
  });
}

function markElectricityDashboardTechnicalSheet_(sheet) {
  if (!isElectricityDashboardTechnicalSheetMarked_(sheet)) {
    sheet.addDeveloperMetadata(ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_KEY_,
      ELECTRICITY_DASHBOARD_TECHNICAL_METADATA_VALUE_);
  }
}

function assertElectricityDashboardCapacity_(spreadsheet, dashboard, technical,
  willCreateTechnicalBackup) {
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
  const backupCells = willCreateTechnicalBackup ?
    ELECTRICITY_DASHBOARD_BACKUP_ROWS_ *
    ELECTRICITY_DASHBOARD_BACKUP_COLUMNS_ : 0;
  if (currentCells - technicalCells + finalTechnicalCells + dashboardCells +
    backupCells >
    ELECTRICITY_DASHBOARD_MAX_SPREADSHEET_CELLS_) {
    throw new Error('Electricity dashboard or its temporary backup exceeds the Google Sheets cell limit.');
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
    const builder = typeof chart.modify === 'function' ? chart.modify() : null;
    const builderState = {};
    if (builder && typeof builder.getChartType === 'function') {
      builderState.chartType = builder.getChartType();
    }
    if (typeof chart.getHiddenDimensionStrategy === 'function') {
      builderState.hiddenDimensionStrategy =
        chart.getHiddenDimensionStrategy();
    }
    if (typeof chart.getMergeStrategy === 'function') {
      builderState.mergeStrategy = chart.getMergeStrategy();
    }
    if (typeof chart.getNumHeaders === 'function') {
      builderState.numHeaders = chart.getNumHeaders();
    }
    if (typeof chart.getTransposeRowsAndColumns === 'function') {
      builderState.transposeRowsAndColumns =
        chart.getTransposeRowsAndColumns();
    }
    layouts[key] = Object.assign({
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
    }, builderState);
  });
  return layouts;
}

function mergeElectricityChartLayouts_(capturedLayouts, preservedLayouts) {
  if (!preservedLayouts) {
    return capturedLayouts;
  }
  const layouts = Object.assign({}, capturedLayouts);
  Object.keys(preservedLayouts).forEach(function (key) {
    layouts[key] = Object.assign({}, capturedLayouts[key] || {},
      preservedLayouts[key]);
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
  if (!block || typeof technical.getRange !== 'function') {
    return 0;
  }
  const range = key === 'annualBands' || key === 'monthlyBands' ? technical.getRange(block.row,
    block.column, block.rows, 1) : technical.getRange(block.row, block.column,
    1, block.columns);
  if (!range || typeof range.getValues !== 'function') {
    return 0;
  }
  const values = range.getValues();
  const dimension = key === 'annualBands' || key === 'monthlyBands' ? values.map(function (row) {
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
    'fontName', 'fontSize', 'hAxis', 'height', 'is3D', 'isStacked', 'legend', 'lineWidth',
    'orientation', 'pieHole', 'pieSliceText', 'pointShape', 'pointSize',
    'reverseCategories', 'series', 'theme', 'tooltip', 'trendlines', 'vAxes',
    'vAxis', 'width', 'titleTextStyle', 'animation', 'axisTitlesPosition',
    'crosshair', 'focusTarget', 'histogram', 'interpolateNulls', 'intervals', 'selectionMode',
    'slices', 'targetAxisIndex', 'viewWindowMode'].forEach(function (key) {
    const value = options.get(key);
    if (value !== null && value !== undefined) {
      preserved[key] = value;
    }
  });
  return preserved;
}

function getElectricityChartLayout_(layouts, key, row, column, width, height) {
  return Object.assign({
    key: key,
    row: row,
    column: column,
    offsetX: 0,
    offsetY: 0,
    width: width,
    height: height,
    hiddenDimensionStrategy:
      Charts.ChartHiddenDimensionStrategy.IGNORE_ROWS,
    mergeStrategy: Charts.ChartMergeStrategy.MERGE_COLUMNS,
    numHeaders: 1,
    transposeRowsAndColumns: false,
    options: {}
  }, layouts[key] || {});
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
  if (layout.chartType !== null && layout.chartType !== undefined &&
    typeof builder.setChartType === 'function') {
    builder.setChartType(layout.chartType);
  }
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
  builder
    .setPosition(layout.row, layout.column, layout.offsetX, layout.offsetY)
    .setOption('title', title)
    .setOption('width', layout.width)
    .setOption('height', layout.height)
    .setOption('legend', layout.options.legend || { position: 'right' });
  if (layout.hiddenDimensionStrategy !== null &&
    layout.hiddenDimensionStrategy !== undefined &&
    typeof builder.setHiddenDimensionStrategy === 'function') {
    builder.setHiddenDimensionStrategy(layout.hiddenDimensionStrategy);
  }
  if (layout.mergeStrategy !== null && layout.mergeStrategy !== undefined &&
    typeof builder.setMergeStrategy === 'function') {
    builder.setMergeStrategy(layout.mergeStrategy);
  }
  if (layout.numHeaders !== null && layout.numHeaders !== undefined &&
    typeof builder.setNumHeaders === 'function') {
    builder.setNumHeaders(layout.numHeaders);
  }
  if (typeof builder.setTransposeRowsAndColumns === 'function') {
    builder.setTransposeRowsAndColumns(Boolean(layout.transposeRowsAndColumns));
  }
  return builder.build();
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
  const rowDimension = key === 'annualBands' || key === 'monthlyBands';
  const previousBoundary = rowDimension ? block.row +
    previousDimension - 1 : block.column + previousDimension - 1;
  const selectedBoundary = rowDimension ? preserved.getRow() +
    preserved.getNumRows() - 1 : preserved.getColumn() +
    preserved.getNumColumns() - 1;
  return selectedBoundary === previousBoundary &&
    getElectricityChartDataDimension_(technical, key) > previousDimension;
}

function extendElectricityChartRange_(preserved, technical, key) {
  const dimension = getElectricityChartDataDimension_(technical, key);
  const block = getElectricityChartManagedBlock_(key);
  if (key === 'annualBands' || key === 'monthlyBands') {
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
  const dateRange = source.sheet + '$' + source.date + '$' + source.firstDataRow +
    ':$' + source.date + '$' + source.lastRow;
  const monthRange = source.sheet + '$' + source.month + '$' + source.firstDataRow +
    ':$' + source.month + '$' + source.lastRow;
  const effectiveYear = electricityBoundedValueOrDatePartFormula_(yearRange,
    dateRange, 'YEAR', 1900, 9999, source.separator);
  const effectiveMonth = electricityBoundedValueOrDatePartFormula_(monthRange,
    dateRange, 'MONTH', 1, 12, source.separator);
  return '=SUMPRODUCT((' + effectiveYear + '=' + year + ')*(' + effectiveMonth +
    '=' + month + ')*' + bandRange + ')';
}

function electricityAnnualFormula_(source, bandColumn, year) {
  const bandRange = source.sheet + '$' + bandColumn + '$' + source.firstDataRow +
    ':$' + bandColumn + '$' + source.lastRow;
  const yearRange = source.sheet + '$' + source.year + '$' + source.firstDataRow +
    ':$' + source.year + '$' + source.lastRow;
  const dateRange = source.sheet + '$' + source.date + '$' + source.firstDataRow +
    ':$' + source.date + '$' + source.lastRow;
  const effectiveYear = electricityBoundedValueOrDatePartFormula_(yearRange,
    dateRange, 'YEAR', 1900, 9999, source.separator);
  return '=SUMPRODUCT((' + effectiveYear + '=' + year + ')*' + bandRange + ')';
}

function electricityBoundedValueOrDatePartFormula_(valueRange, dateRange,
  datePart, minimum, maximum, separator) {
  const parsedValue = 'VALUE(' + valueRange + ')';
  const fallback = datePart + '(' + dateRange + ')';
  return 'IFERROR(IF((' + parsedValue + '>=' + minimum + ')*(' +
    parsedValue + '<=' + maximum + ')' + separator + parsedValue + separator +
    fallback + ')' + separator + fallback + ')';
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
  // A replacement can remove a previously represented year, even when its
  // new year is already present. Rebuild on every electricity import so both
  // additions and removals are reflected, and grow a range only when its
  // captured boundary has new data beyond it.
  const extendManagedRanges = true;
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
