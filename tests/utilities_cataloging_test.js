#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.resolve(__dirname, '..');
const sources = ['Config.gs', 'locales/en.gs', 'locales/it.gs', 'Localization.gs',
  'UtilitiesCataloging.gs'].map((file) =>
  fs.readFileSync(path.join(projectRoot, file), 'utf8')
);

function loadCataloger(overrides = {}) {
  const context = vm.createContext({
    console,
    isFinite,
    MimeType: { PDF: 'application/pdf' },
    Session: { getScriptTimeZone: () => 'Etc/UTC' },
    Utilities: {
      base64Encode: () => 'encoded-pdf',
      formatDate: () => '2026-07-16',
      newBlob: (value) => ({
        getBytes: () => Array.from(Buffer.from(String(value), 'utf8'))
      }),
      sleep: () => {}
    },
    ScriptApp: {
      getOAuthToken: () => 'oauth-token'
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => '' })
    },
    SpreadsheetApp: {
      CopyPasteType: {
        PASTE_FORMAT: 'format',
        PASTE_FORMULA: 'formula'
      },
      newRichTextValue: () => {
        const value = {
          text: '',
          link: '',
          setText(text) {
            this.text = text;
            return this;
          },
          setLinkUrl(link) {
            this.link = link;
            return this;
          },
          build() {
            return { text: this.text, link: this.link };
          }
        };
        return value;
      }
    },
    ...overrides
  });
  sources.forEach((source, index) => {
    vm.runInContext(source, context, {
      filename: ['Config.gs', 'locales/en.gs', 'locales/it.gs',
        'Localization.gs', 'UtilitiesCataloging.gs'][index]
    });
  });
  return context;
}

function validInvoice() {
  return {
    document_type: 'Invoice',
    supplier: 'SUPPLIER',
    supply_type: 'Water',
    address_type: 'import',
    account_holder: 'Avery North',
    issue_date: '2026-07-16',
    address_evidence: 'Avery North, Cedar Meridian Boulevard 125, Rivermouth',
    service_street: 'Cedar Meridian Boulevard',
    service_civic_number: '125',
    service_city: 'Rivermouth',
    service_postal_code: '99991',
    identifier: 'INV-1',
    contract_number: 'CONTRACT-1',
    customer_code: 'CUSTOMER-1',
    contract_object: '',
    reference_year: 2026,
    reference_month: '06',
    frequency: 'monthly',
    frequency_source_evidence: 'printed',
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    cost_consumption: 10,
    cost_non_consumption: 2,
    vat: 2.64,
    total: 14.64,
    problems: [],
    sheet_values: []
  };
}

function testServiceIdentityMatchesNormalizedHolderAndAddress() {
  const context = loadCataloger();
  const extracted = {
    account_holder: 'NORTH, Avery',
    address_evidence: 'Corso Cedar Meridian Boulevard, 125 - 99991 RIVERMOUTH',
    service_street: 'C.so Cedar Meridian Boulevard',
    service_civic_number: '125',
    service_city: 'RIVERMOUTH',
    service_postal_code: '99991'
  };
  const expected = {
    account_holder: 'Avery North',
    service_address: 'Corso Cedar Meridian Boulevard 125, 99991 Rivermouth'
  };

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.validateServiceIdentity_(extracted, expected))),
    { valid: true }
  );
}

function testFirstInvoiceCanEstablishMissingServiceIdentity() {
  const context = loadCataloger();
  const cells = [
    ['Controllo fornitura', 'Water', '', '', 'Enter account holder here',
      'Enter service address here'],
    ['Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Account holder', 'Service address']
  ];
  let lastRow = 2;
  const sheet = {
    getName: () => 'Water',
    getLastRow: () => lastRow,
    getRange: (row, column) => ({
      getDisplayValue: () => String((cells[row - 1] || [])[column - 1] || '')
    })
  };
  context.getAutomationConfig_ = () => ({
    locale: 'en',
    sheet_by_supply: { Water: 'Water' }
  });
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.getSheetLayout_ = () => ({
    headerRow: 2,
    headers: cells[1],
    lookup: {
      'issue date': 1,
      supplier: 2,
      'invoice number': 3,
      'contract number': 4,
      'account holder': 5,
      'service address': 6
    }
  });

  const result = context.validateServiceIdentityForInvoice_(validInvoice());

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    valid: true,
    initialServiceIdentityBootstrapEligible: true
  });
  const incompleteInvoice = Object.assign({}, validInvoice(), {
    account_holder: '',
    address_evidence: '',
    service_street: '',
    service_civic_number: '',
    service_city: ''
  });
  const incompleteResult = context.validateServiceIdentityForInvoice_(
    incompleteInvoice);
  assert.equal(incompleteResult.valid, false);
  assert.equal(incompleteResult.code, 'service_identity_missing');
  assert.equal(incompleteResult.repairable, true);
  cells[0][4] = 'Avery North';
  const holderOnlyResult = context.validateServiceIdentityForInvoice_(validInvoice());
  assert.equal(holderOnlyResult.valid, false);
  assert.equal(holderOnlyResult.code, 'target_identity_not_configured');
  cells[0][4] = 'Enter account holder here';
  cells[0][5] = 'Cedar Meridian Boulevard 125 99991 Rivermouth';
  const addressOnlyResult = context.validateServiceIdentityForInvoice_(validInvoice());
  assert.equal(addressOnlyResult.valid, false);
  assert.equal(addressOnlyResult.code, 'target_identity_not_configured');
  cells[0][5] = 'Enter service address here';
  lastRow = 3;
  const migratedResult = context.validateServiceIdentityForInvoice_(validInvoice());
  assert.equal(migratedResult.valid, false);
  assert.equal(migratedResult.code, 'target_identity_not_configured');
}

function testFirstInvoiceRequiresManagedServiceIdentityMetadata() {
  const context = loadCataloger();
  const cells = [
    ['', 'Water', '', '', 'Enter account holder here',
      'Enter service address here'],
    ['Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Account holder', 'Service address']
  ];
  const sheet = {
    getName: () => 'Water',
    getLastRow: () => 2,
    getRange: (row, column) => ({
      getDisplayValue: () => String((cells[row - 1] || [])[column - 1] || ''),
      getFormula: () => ''
    })
  };
  context.getAutomationConfig_ = () => ({ sheet_by_supply: { Water: 'Water' } });
  context.SpreadsheetApp.openById = () => ({ getSheetByName: () => sheet });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.getSheetLayout_ = () => ({
    headerRow: 2,
    lookup: { 'account holder': 5, 'service address': 6 }
  });
  const result = context.validateServiceIdentityForInvoice_(validInvoice());
  assert.equal(result.valid, false);
  assert.equal(result.code, 'target_identity_not_configured');
  cells[0][0] = 'Controllo fornitura';
  cells[0][1] = 'Electricity';
  const sharedTabResult = context.validateServiceIdentityForInvoice_(
    validInvoice());
  assert.equal(sharedTabResult.valid, true);
  context.getAutomationConfig_ = () => ({
    sheet_by_supply: { Water: 'Different target tab' }
  });
  const mismatchResult = context.validateServiceIdentityForInvoice_(
    validInvoice());
  assert.equal(mismatchResult.valid, false);
  assert.equal(mismatchResult.code, 'target_identity_not_configured');
}

function testFirstInvoiceCannotReplaceFormulaBackedIdentityControls() {
  const context = loadCataloger();
  const sheet = {
    getLastRow: () => 2,
    getRange: (_row, column) => ({
      getDisplayValue: () => '',
      getFormula: () => column === 5 ? '=Settings!B2' : '=Settings!B3'
    })
  };
  context.getAutomationConfig_ = () => ({
    locale: 'en',
    sheet_by_supply: { Water: 'Water' }
  });
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.getSheetLayout_ = () => ({
    headerRow: 2,
    headers: ['Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Account holder', 'Service address'],
    lookup: {
      'issue date': 1,
      supplier: 2,
      'invoice number': 3,
      'contract number': 4,
      'account holder': 5,
      'service address': 6
    }
  });

  const result = context.validateServiceIdentityForInvoice_(validInvoice());

  assert.equal(result.valid, false);
  assert.equal(result.code, 'target_identity_not_configured');
}

function testLegacyHeaderRowWithoutControlsRemainsFailClosed() {
  const context = loadCataloger();
  const sheet = {
    getLastRow: () => 1,
    getRange: () => {
      throw new Error('row zero must never be accessed');
    }
  };
  context.getAutomationConfig_ = () => ({
    locale: 'en',
    sheet_by_supply: { Water: 'Water' }
  });
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Issue date', 'Supplier', 'Invoice number', 'Source file'],
    lookup: {
      'issue date': 1,
      supplier: 2,
      'invoice number': 3,
      'source file': 4
    }
  });

  const result = context.validateServiceIdentityForInvoice_(validInvoice());

  assert.equal(result.valid, false);
  assert.equal(result.code, 'target_identity_not_configured');
}

function testServiceIdentityAcceptsComponentAndEvidencePermutations() {
  const context = loadCataloger();
  const expectedAddresses = [
    'Rivermouth 125 Corso Cedar Meridian Boulevard 99991',
    '99991 125 Rivermouth Corso Cedar Meridian Boulevard',
    'Corso Cedar Meridian Boulevard Rivermouth 125'
  ];
  const evidenceAddresses = [
    'Account details: Rivermouth, 99991; 125 Corso Cedar Meridian Boulevard.',
    '125 - Corso Cedar Meridian Boulevard - notes - Rivermouth 99991',
    'Other text 99991 Rivermouth Corso Cedar Meridian Boulevard 125'
  ];

  expectedAddresses.forEach((serviceAddress, index) => {
    const result = context.validateServiceIdentity_({
      account_holder: 'Avery North',
      address_evidence: evidenceAddresses[index],
      service_street: 'C.so Cedar Meridian Boulevard',
      service_civic_number: '125',
      service_city: 'Rivermouth',
      service_postal_code: '99991'
    }, {
      account_holder: 'Avery North',
      service_address: serviceAddress
    });

    assert.deepEqual(JSON.parse(JSON.stringify(result)), { valid: true });
  });
}

function testServiceIdentityRejectsExtractedStreetPrefix() {
  const context = loadCataloger();
  const result = context.validateServiceIdentity_({
    account_holder: 'Avery North',
    address_evidence: 'Cedar Meridian Boulevard 125, Rivermouth',
    service_street: 'Cedar Meridian',
    service_civic_number: '125',
    service_city: 'Rivermouth',
    service_postal_code: ''
  }, {
    account_holder: 'Avery North',
    service_address: 'Cedar Meridian Boulevard 125, Rivermouth'
  });

  assert.equal(result.valid, false);
  assert.match(result.problem, /does not match/);
}

function testServiceIdentityRejectsExtractedComponentSuffix() {
  const context = loadCataloger();
  const result = context.validateServiceIdentity_({
    account_holder: 'Avery North',
    address_evidence: 'Birch Loop 10, Rivermouth Center',
    service_street: 'Birch Loop',
    service_civic_number: '10',
    service_city: 'Rivermouth Center',
    service_postal_code: ''
  }, {
    account_holder: 'Avery North',
    service_address: 'Birch Loop 10, Rivermouth'
  });

  assert.equal(result.valid, false);
  assert.match(result.problem, /does not match/);
}

function testServiceIdentityRejectsWrongAddressAndMissingBaseline() {
  const context = loadCataloger();
  const extracted = {
    account_holder: 'Avery North',
    address_evidence: 'Alder Workshop Way 126, Rivermouth',
    service_street: 'Alder Workshop Way',
    service_civic_number: '126',
    service_city: 'Rivermouth',
    service_postal_code: '99991'
  };

  assert.equal(
    context.validateServiceIdentity_(extracted, {
      account_holder: 'Avery North',
      service_address: 'Cedar Meridian Boulevard 125, Rivermouth'
    }).valid,
    false
  );
  assert.match(
    context.validateServiceIdentity_(extracted, {
      account_holder: 'Avery North',
      service_address: 'Cedar Meridian Boulevard 125, Rivermouth'
    }).problem,
    /does not match/
  );
  assert.match(
    context.validateServiceIdentity_(extracted, {
      account_holder: '',
      service_address: ''
    }).problem,
    /no configured account holder/
  );
}

function testServiceIdentityRejectsCityMatchedByStreetTokens() {
  const context = loadCataloger();
  const result = context.validateServiceIdentity_({
    account_holder: 'Avery North',
    address_evidence: 'Birch Loop 10, Birch Loop',
    service_street: 'Birch Loop',
    service_civic_number: '10',
    service_city: 'Birch Loop',
    service_postal_code: ''
  }, {
    account_holder: 'Avery North',
    service_address: 'Birch Loop 10, Stonehaven'
  });

  assert.equal(result.valid, false);
  assert.match(result.problem, /does not match/);
}

function testServiceIdentityRejectsOverlappingRepeatedEvidenceComponents() {
  const context = loadCataloger();
  const result = context.validateServiceIdentity_({
    account_holder: 'Avery North',
    address_evidence: 'Birch Loop 10',
    service_street: 'Birch Loop',
    service_civic_number: '10',
    service_city: 'Birch Loop',
    service_postal_code: ''
  }, {
    account_holder: 'Avery North',
    service_address: 'Birch Loop 10 Birch Loop'
  });

  assert.equal(result.valid, false);
  assert.match(result.problem, /does not match/);
}

function testServiceIdentityRejectsUncorroboratedAddressEvidence() {
  const context = loadCataloger();
  const result = context.validateServiceIdentity_({
    account_holder: 'Avery North',
    address_evidence: 'Alder Workshop Way 126, Rivermouth',
    service_street: 'Cedar Meridian Boulevard',
    service_civic_number: '125',
    service_city: 'Rivermouth',
    service_postal_code: '99991'
  }, {
      account_holder: 'Avery North',
      service_address: 'Cedar Meridian Boulevard 125, Rivermouth'
  });

  assert.equal(result.valid, false);
  assert.match(result.problem, /does not match/);
}

function testServiceIdentityRejectsCivicNumberAmbiguity() {
  const context = loadCataloger();
  const result = context.validateServiceIdentity_({
    account_holder: 'Avery North',
    address_evidence: 'Cedar Meridian Boulevard 125/A, Rivermouth',
    service_street: 'Cedar Meridian Boulevard',
    service_civic_number: '125/A',
    service_city: 'Rivermouth',
    service_postal_code: ''
  }, {
      account_holder: 'Avery North',
      service_address: 'Cedar Meridian Boulevard 125, Rivermouth'
  });

  assert.equal(result.valid, false);
}

function testServiceIdentityRejectsMissingAddressComponents() {
  const context = loadCataloger();
  const result = context.validateServiceIdentity_({
    account_holder: 'Avery North',
    address_evidence: 'Cedar Meridian Boulevard 125, Rivermouth',
    service_street: 'Cedar Meridian Boulevard',
    service_civic_number: '',
    service_city: 'Rivermouth',
    service_postal_code: ''
  }, {
      account_holder: 'Avery North',
      service_address: 'Cedar Meridian Boulevard 125, Rivermouth'
  });

  assert.equal(result.valid, false);
  assert.match(result.problem, /missing or ambiguous/);
}

function installScriptPropertyStore(context, initialValues = {}) {
  const store = { ...initialValues };
  const properties = {
    getProperties: () => ({ ...store }),
    getProperty: (key) => Object.prototype.hasOwnProperty.call(store, key) ?
      store[key] : null,
    setProperty: (key, value) => {
      store[key] = value;
    },
    setProperties: (values) => Object.assign(store, values),
    deleteProperty: (key) => {
      delete store[key];
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => properties
  };
  return { properties, store };
}

function driveIterator(items) {
  let index = 0;
  return {
    hasNext: () => index < items.length,
    next: () => items[index++]
  };
}

function managedSupplierProfileWorkspaceState(rootFolderId, profileRootId) {
  return {
    rootFolderId,
    profileRootParentId: rootFolderId,
    profileRootName: 'Supplier Profiles',
    profileRootStatus: 'managed',
    profileRootId,
    templateFolderParentId: profileRootId,
    templateFolderName: '_template',
    templateFolderStatus: 'managed',
    templateFolderId: 'template-folder-id'
  };
}

function testManagedSupplierProfileWorkspaceIdentityIsRequired() {
  const profileText = '---\nstatus: approved\nsupplier: ILIAD\n---\n# Profile';
  const profile = {
    isTrashed: () => false,
    getSize: () => profileText.length,
    getBlob: () => ({ getDataAsString: () => profileText })
  };
  const supplierFolder = {
    isTrashed: () => false,
    getName: () => 'ILIAD',
    getFilesByName: (name) => {
      assert.equal(name, 'PROFILE.md');
      return driveIterator([profile]);
    }
  };
  const profileRoot = {
    isTrashed: () => false,
    getId: () => 'managed-profile-root-id',
    getName: () => 'Supplier Profiles',
    getUrl: () => 'https://drive.test/managed-profile-root-id',
    getFolders: () => driveIterator([supplierFolder])
  };
  const rootFolder = {
    getId: () => 'root-folder-id',
    getFoldersByName: (name) => {
      assert.equal(name, 'Supplier Profiles');
      return driveIterator([profileRoot]);
    }
  };
  const context = loadCataloger({
    DriveApp: { getFolderById: (id) => {
      assert.equal(id, 'managed-profile-root-id');
      return profileRoot;
    } }
  });
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  installScriptPropertyStore(context, {
    SUPPLIER_PROFILE_WORKSPACE_STATE: JSON.stringify(
      managedSupplierProfileWorkspaceState('root-folder-id',
        'managed-profile-root-id')
    )
  });

  assert.match(context.loadApprovedSupplierProfiles_(rootFolder),
    /BEGIN APPROVED SUPPLIER PROFILE: ILIAD/);
  assert.equal(context.getSupplierProfilesFolderUrl_(rootFolder),
    'https://drive.test/managed-profile-root-id');
}

function testSupplierProfilesAreOmittedWithoutWorkspaceState() {
  const context = loadCataloger({
    DriveApp: { getFolderById: () => { throw new Error('must not resolve'); } }
  });
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  installScriptPropertyStore(context);
  const rootFolder = {
    getFoldersByName: () => { throw new Error('must not inspect profiles'); }
  };
  context.loadDriveAgentsPolicy_ = () => 'root policy';

  assert.equal(context.loadApprovedSupplierProfiles_(rootFolder), '');
  assert.equal(context.loadTrustedExtractionPolicy_(rootFolder), 'root policy');
}

function testSupplierProfilesSkipStateLookupForMinimalRootAdapter() {
  const context = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => { throw new Error('must not read state'); }
      })
    }
  });

  assert.equal(context.loadApprovedSupplierProfiles_({}), '');
}

function testSupplierProfileWorkspaceRejectsIncompleteState() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  const { store } = installScriptPropertyStore(context, {
    SUPPLIER_PROFILE_WORKSPACE_STATE: JSON.stringify({
      rootFolderId: 'root-folder-id',
      profileRootStatus: 'managed',
      profileRootId: 'managed-profile-root-id'
    })
  });
  const rootFolder = {
    getId: () => 'root-folder-id',
    getFoldersByName: () => { throw new Error('must not inspect profiles'); }
  };

  assert.throws(() => context.loadApprovedSupplierProfiles_(rootFolder),
    /supplier profile workspace state is incomplete/);
  store.SUPPLIER_PROFILE_WORKSPACE_STATE = '{';
  assert.throws(() => context.loadApprovedSupplierProfiles_(rootFolder),
    /supplier profile workspace state is malformed/);
}

function testSupplierProfileWorkspaceRejectsSameNamedReplacement() {
  const recordedProfileRoot = {
    getId: () => 'managed-profile-root-id',
    getName: () => 'Supplier Profiles'
  };
  const replacement = {
    isTrashed: () => false,
    getId: () => 'user-owned-replacement-id'
  };
  const rootFolder = {
    getId: () => 'root-folder-id',
    getFoldersByName: () => driveIterator([replacement])
  };
  const context = loadCataloger({
    DriveApp: { getFolderById: () => recordedProfileRoot }
  });
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  installScriptPropertyStore(context, {
    SUPPLIER_PROFILE_WORKSPACE_STATE: JSON.stringify(
      managedSupplierProfileWorkspaceState('root-folder-id',
        'managed-profile-root-id')
    )
  });

  assert.throws(() => context.loadApprovedSupplierProfiles_(rootFolder),
    /profile root identity does not match the configured intake folder/);
}

function testSupplierProfileWorkspaceRejectsUnavailableRecordedRoot() {
  const rootFolder = {
    getId: () => 'root-folder-id',
    getFoldersByName: () => { throw new Error('must not inspect profiles'); }
  };
  const context = loadCataloger({
    DriveApp: { getFolderById: () => { throw new Error('not found'); } }
  });
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  installScriptPropertyStore(context, {
    SUPPLIER_PROFILE_WORKSPACE_STATE: JSON.stringify(
      managedSupplierProfileWorkspaceState('root-folder-id',
        'missing-profile-root-id')
    )
  });

  assert.throws(() => context.loadApprovedSupplierProfiles_(rootFolder),
    /recorded supplier profile root is unavailable, moved, or renamed/);
}

function testSupplierProfileContextLimitIncludesRenderedMetadata() {
  const profiles = ['ALIAD', 'BLIAD', 'CLIAD'].map((supplier) => {
    const profileText = '---\nstatus: approved\nsupplier: ' + supplier + '\n---\n' +
      'x'.repeat(16340);
    return {
      isTrashed: () => false,
      getSize: () => Buffer.byteLength(profileText, 'utf8'),
      getBlob: () => ({ getDataAsString: () => profileText })
    };
  });
  const supplierFolders = ['a'.repeat(80) + '1', 'a'.repeat(80) + '2',
    'a'.repeat(80) + '3'].map((name, index) => ({
    isTrashed: () => false,
    getName: () => name,
    getFilesByName: () => driveIterator([profiles[index]])
  }));
  const profileRoot = {
    isTrashed: () => false,
    getId: () => 'managed-profile-root-id',
    getName: () => 'Supplier Profiles',
    getFolders: () => driveIterator(supplierFolders)
  };
  const rootFolder = {
    getId: () => 'root-folder-id',
    getFoldersByName: () => driveIterator([profileRoot])
  };
  const context = loadCataloger({
    DriveApp: { getFolderById: () => profileRoot }
  });
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  installScriptPropertyStore(context, {
    SUPPLIER_PROFILE_WORKSPACE_STATE: JSON.stringify(
      managedSupplierProfileWorkspaceState('root-folder-id',
        'managed-profile-root-id')
    )
  });

  assert.equal(profiles.reduce((total, profile) => total + profile.getSize(), 0), 49143);
  assert.throws(() => context.loadApprovedSupplierProfiles_(rootFolder),
    /Combined approved supplier profiles exceed the context limit/);
}

function testSupplierProfilesRejectDuplicateMetadataSuppliersAcrossFolders() {
  const makeProfile = (supplier) => {
    const profileText = '---\nstatus: approved\nsupplier: ' + supplier +
      '\n---\n# Profile';
    return {
      isTrashed: () => false,
      getSize: () => Buffer.byteLength(profileText, 'utf8'),
      getBlob: () => ({ getDataAsString: () => profileText })
    };
  };
  const supplierFolders = [
    ['Active Iliad profile', makeProfile('Iliad Internet')],
    ['Stale duplicate profile', makeProfile('ILIAD   Internet')]
  ].map(([name, profile]) => ({
    isTrashed: () => false,
    getName: () => name,
    getFilesByName: () => driveIterator([profile])
  }));
  const profileRoot = {
    isTrashed: () => false,
    getId: () => 'managed-profile-root-id',
    getName: () => 'Supplier Profiles',
    getFolders: () => driveIterator(supplierFolders)
  };
  const rootFolder = {
    getId: () => 'root-folder-id',
    getFoldersByName: () => driveIterator([profileRoot])
  };
  const context = loadCataloger({
    DriveApp: { getFolderById: () => profileRoot }
  });
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  installScriptPropertyStore(context, {
    SUPPLIER_PROFILE_WORKSPACE_STATE: JSON.stringify(
      managedSupplierProfileWorkspaceState('root-folder-id',
        'managed-profile-root-id')
    )
  });

  assert.throws(() => context.loadApprovedSupplierProfiles_(rootFolder),
    /More than one approved supplier profile exists for the same supplier/);
}

function testFormulaLikeTextIsWrittenLiterally() {
  const context = loadCataloger();
  [
    '=IMPORTXML("https://example.test")',
    '+SUM(1,2)',
    '-1+2',
    '@SUM(1,2)'
  ].forEach((candidate) => {
    const calls = [];
    const range = {
      setRichTextValue: (value) => calls.push(['rich', value]),
      setValue: (value) => calls.push(['value', value])
    };

    context.setLiteralSheetValue_(range, candidate);

    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'rich');
    assert.equal(calls[0][1].text, candidate);
  });
}

function testExtractionSchemaAndCalendarValidation() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    locale: 'it',
    canonical_suppliers: ['SUPPLIER', 'ILIAD', 'Energygas Italia'],
    supplier_aliases: {},
    canonical_supplies: ['Water', 'Internet'],
    supply_aliases: {},
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: []
  });
  const raw = {
    ...validInvoice()
  };
  context.validateRawExtractionShape_(raw);
  assert.equal(context.validateExtraction_(raw).valid, true);
  const normalized = context.normalizeExtraction_({
    ...raw,
    contract_number: '  CONTRACT-2 ',
    customer_code: ' CUSTOMER-2  ',
    reference_month: '7'
  });
  assert.equal(normalized.contract_number, 'CONTRACT-2');
  assert.equal(normalized.customer_code, 'CUSTOMER-2');
  assert.equal(normalized.reference_month, '07');
  assert.equal(typeof normalized.reference_month, 'string');

  const digitOnlyIdentifiers = context.normalizeExtraction_({
    ...raw,
    identifier: 16657014,
    contract_number: 123456,
    customer_code: 53009296
  });
  assert.equal(typeof digitOnlyIdentifiers.identifier, 'string');
  assert.equal(typeof digitOnlyIdentifiers.contract_number, 'string');
  assert.equal(typeof digitOnlyIdentifiers.customer_code, 'string');

  const iliadDefault = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."],
    sheet_values: []
  });
  context.applySupplierFieldDefaults_(iliadDefault, ["Spese d'incasso"]);
  assert.equal(JSON.stringify(iliadDefault.sheet_values), JSON.stringify([
    { header: "Spese d'incasso", value: 0 }
  ]));
  assert.deepEqual(iliadDefault.problems, []);

  const iliadPrintedCharge = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    sheet_values: [{ header: "Spese d'incasso", value: 1.25 }]
  });
  context.applySupplierFieldDefaults_(iliadPrintedCharge, ["Spese d'incasso"]);
  assert.equal(JSON.stringify(iliadPrintedCharge.sheet_values), JSON.stringify([
    { header: "Spese d'incasso", value: 1.25 }
  ]));

  const iliadPrintedZeroCharge = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    sheet_values: [{
      header: "Spese d'incasso",
      value: 0,
      source_evidence: 'printed'
    }]
  });
  context.applySupplierFieldDefaults_(iliadPrintedZeroCharge, ["Spese d'incasso"]);
  assert.equal(iliadPrintedZeroCharge.sheet_values[0].value, 0);
  assert.deepEqual(iliadPrintedZeroCharge.problems, []);

  const iliadUnprovenZeroCharge = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    sheet_values: [{ header: "Spese d'incasso", value: 0 }]
  });
  context.applySupplierFieldDefaults_(iliadUnprovenZeroCharge, ["Spese d'incasso"]);
  assert.equal(context.validateExtraction_(iliadUnprovenZeroCharge).valid, false);
  assert.match(iliadUnprovenZeroCharge.problems[0], /not established by printed evidence/);

  const iliadEmptyCharge = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."],
    sheet_values: [{ header: "Spese d'incasso", value: null }]
  });
  context.applySupplierFieldDefaults_(iliadEmptyCharge, ["Spese d'incasso"]);
  assert.equal(iliadEmptyCharge.sheet_values[0].value, 0);

  const iliadUnreadableCharge = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso amount missing or unreadable."],
    sheet_values: [{ header: "Spese d'incasso", value: null }]
  });
  context.applySupplierFieldDefaults_(iliadUnreadableCharge, ["Spese d'incasso"]);
  assert.equal(iliadUnreadableCharge.sheet_values[0].value, null);
  assert.equal(context.validateExtraction_(iliadUnreadableCharge).valid, false);

  const iliadWithoutConfiguredChargeColumn = context.normalizeExtraction_({
    ...raw,
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."],
    sheet_values: []
  });
  context.applySupplierFieldDefaults_(iliadWithoutConfiguredChargeColumn, []);
  assert.deepEqual(iliadWithoutConfiguredChargeColumn.sheet_values, []);
  assert.deepEqual(iliadWithoutConfiguredChargeColumn.problems, []);

  const iliadReport = context.normalizeExtraction_({
    ...raw,
    document_type: 'Report',
    supplier: 'ILIAD',
    supply_type: 'Internet',
    sheet_values: []
  });
  context.applySupplierFieldDefaults_(iliadReport, ["Spese d'incasso"]);
  assert.deepEqual(iliadReport.sheet_values, []);

  const energygas = context.normalizeExtraction_({
    ...raw,
    supplier: 'Energygas Italia',
    contract_number: 'CL000001',
    customer_code: ''
  });
  assert.equal(energygas.contract_number, '');
  assert.equal(energygas.customer_code, 'CL000001');

  ['CL-000001', 'CL 000001', 'CL/000001'].forEach((contractNumber) => {
    const formattedEnergygas = context.normalizeExtraction_({
      ...raw,
      supplier: 'Energygas Italia',
      contract_number: contractNumber,
      customer_code: ''
    });
    assert.equal(formattedEnergygas.contract_number, '');
    assert.equal(formattedEnergygas.customer_code, contractNumber);
  });

  const duplicatedEnergygas = context.normalizeExtraction_({
    ...raw,
    supplier: 'Energygas Italia',
    contract_number: 'CL000001',
    customer_code: 'CL000001'
  });
  assert.equal(duplicatedEnergygas.contract_number, '');
  assert.equal(duplicatedEnergygas.customer_code, 'CL000001');

  const normalizedSheetValues = context.normalizeExtraction_({
    ...raw,
    sheet_values: [{ header: '  Unità di misura consumi  ', value: ' mc  ' }]
  }).sheet_values;
  assert.equal(JSON.stringify(normalizedSheetValues), JSON.stringify([
    { header: 'Unità di misura consumi', value: 'mc' }
  ]));

  const bandValues = context.normalizeExtraction_({
    ...raw,
    sheet_values: [{ header: 'Quantità consumi F1', value: '368,74 kWh' }]
  }).sheet_values;
  assert.equal(bandValues[0].value, 368.74);
  assert.equal(context.normalizeElectricityBandConsumption_('1.234,56 kWh'),
    1234.56);
  assert.equal(context.normalizeElectricityBandConsumption_('1,234 kWh'), null);
  assert.equal(context.normalizeElectricityBandConsumption_('1.234 kWh'), null);
  assert.equal(context.normalizeElectricityBandConsumption_('1,234,567 kWh'),
    1234567);
  assert.equal(context.normalizeElectricityBandConsumption_('1.234.567 kWh'),
    1234567);
  assert.throws(() => context.normalizeExtraction_({
    ...raw,
    sheet_values: [{ header: 'Quantità consumi F1', value: 'not available' }]
  }), /nonnumeric electricity band consumption/);

  assert.throws(
    () => context.validateRawExtractionShape_({
      ...raw,
      identifier: { unexpected: true }
    }),
    /invalid type/
  );
  assert.throws(
    () => context.validateRawExtractionShape_({
      ...raw,
      period_end: '2026-02-30'
    }),
    /invalid date/
  );
  assert.throws(
    () => context.validateRawExtractionShape_({
      ...raw,
      sheet_values: [{ header: 'Collection charges', value: 0,
        source_evidence: 'inferred' }]
    }),
    /invalid entry/
  );

  const invalidMonth = { ...raw, reference_month: '13' };
  assert.equal(context.validateExtraction_(invalidMonth).valid, false);
  const invalidSupplier = { ...raw, supplier: '|||***' };
  assert.equal(context.validateExtraction_(invalidSupplier).valid, false);

  const onlyCustomerCode = {
    ...raw,
    contract_number: '',
    customer_code: 'ID-UTENTE-1',
    problems: ['Numero di contratto assente nel documento.']
  };
  assert.equal(context.validateExtraction_(onlyCustomerCode).valid, true);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Numero contratto non presente nel documento.']
  }).valid, true);

  const onlyContractNumber = {
    ...raw,
    contract_number: 'CONTRACT-ONLY',
    customer_code: '',
    problems: ['ID utente missing from the document.']
  };
  assert.equal(context.validateExtraction_(onlyContractNumber).valid, true);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Codice contratto assente nel documento.']
  }).valid, true);
  assert.equal(context.validateExtraction_({
    ...onlyContractNumber,
    problems: ['Numero cliente assente']
  }).valid, true);
  assert.equal(context.validateExtraction_({
    ...onlyContractNumber,
    problems: ['Contract number absent']
  }).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Customer code absent']
  }).valid, false);

  const noOwnershipIdentifier = {
    ...raw,
    contract_number: '',
    customer_code: '',
    problems: []
  };
  const noOwnershipValidation = context.validateExtraction_(noOwnershipIdentifier);
  assert.equal(noOwnershipValidation.valid, false);
  assert.match(noOwnershipValidation.problem, /Contract number and customer code are both missing/);

  const otherProblemRemainsBlocking = {
    ...onlyCustomerCode,
    problems: ['Numero di contratto assente nel documento.', 'VAT cannot be verified.']
  };
  assert.equal(context.validateExtraction_(otherProblemRemainsBlocking).valid, false);

  const mixedIdentifierProblem = {
    ...onlyCustomerCode,
    problems: ['Numero di contratto assente nel documento; periodo ambiguo.']
  };
  assert.equal(context.validateExtraction_(mixedIdentifierProblem).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Numero di contratto assente, importo illeggibile.']
  }).valid, false);

  const informationalVatInclusion = {
    ...onlyCustomerCode,
    problems: [
      'Gli importi delle singole voci nel dettaglio servizi sono riportati nel documento comprensivi di IVA al 22%.'
    ]
  };
  assert.equal(context.validateExtraction_(informationalVatInclusion).valid, true);
  const missingFrequency = {
    ...raw,
    frequency: '',
    problems: ['Frequenza di fatturazione non indicata esplicitamente nel documento.']
  };
  assert.equal(context.validateExtraction_(missingFrequency).valid, false);
  assert.equal(context.isMissingFrequencyProblem_(missingFrequency.problems[0]), true);
  assert.equal(context.isMissingFrequencyProblem_('Billing frequency is not printed on the invoice.'), true);
  assert.equal(context.isMissingFrequencyProblem_('Frequency absent because the billing period is unreadable.'), false);
  assert.equal(context.isMissingFrequencyProblem_('Frequency absent because the billing period is missing.'), false);
  assert.equal(context.isMissingFrequencyProblem_('Frequency does not match the billing history.'), false);
  assert.equal(context.isMissingFrequencyProblem_('Frequency evidence is conflicting.'), false);
  assert.equal(context.isMissingFrequencyProblem_('Billing frequency is not printed on the supplier invoice.'), true);
  assert.equal(context.isMissingFrequencyProblem_(
    'La frequenza di fatturazione non è stampata esplicitamente sul documento.'
  ), true);
  assert.equal(context.validateExtraction_({
    ...missingFrequency,
    problems: [
      'Frequenza di fatturazione non indicata esplicitamente nel documento; periodo ambiguo.'
    ]
  }).valid, false);
  [
    'Unità di misura non indicata.',
    'Sconto non applicabile.'
  ].forEach((problem) => {
    assert.equal(context.validateExtraction_({ ...raw, problems: [problem] }).valid, false);
  });
  [
    'Quantità consumi F1 incerta.',
    'Quantity absent because supplier is missing.',
    'Identifier is ambiguous.',
    'Numero documento illeggibile.',
    'N. fattura illeggibile.',
    'Billing period unreadable.',
    'Periodo di fatturazione ambiguo.',
    'Billed period unavailable.',
    'Reference period unclear.',
    'Periodo di competenza non disponibile.',
    'Identificativo ambiguo.',
    'Electricity consumption unreadable.',
    'Consumo elettrico illeggibile.',
    'Quantità consumi F1 non riportata.',
    'F1 unreadable.',
    'Fascia F2 illeggibile.',
    'Quantità consumi F1 assente o illeggibile.'
  ].forEach((problem) => {
    assert.equal(context.validateExtraction_({ ...raw, problems: [problem] }).valid, false);
  });
  [
    'Frequency absent because the reference period is unclear.',
    'Frequenza assente perche il periodo di riferimento e ambiguo.'
  ].forEach((problem) => {
    assert.equal(context.isMissingFrequencyProblem_(problem), false);
    assert.equal(context.validateExtraction_({ ...raw, problems: [problem] }).valid, false);
  });
  [
    'Unità di misura non leggibile.',
    'Tariff is unclear.',
    'Payment method unreadable.'
  ].forEach((problem) => {
    assert.equal(context.validateExtraction_({ ...raw, problems: [problem] }).valid, false);
  });
  assert.equal(context.validateExtraction_({
    ...raw,
    problems: ['Sconto non riportato in fattura.']
  }).valid, false);
  assert.equal(context.validateExtraction_({
    ...raw,
    problems: ['Frequenza non indicata in fattura.']
  }).valid, false);
  assert.equal(context.validateExtraction_({
    ...raw,
    problems: ['Custom field non applicabile.']
  }).valid, false);
  [
    'PDF appears incomplete.',
    'Document authenticity is uncertain.',
    'Charges are inconsistent.'
  ].forEach((problem) => {
    assert.equal(context.validateExtraction_({ ...raw, problems: [problem] }).valid, false);
  });
  assert.equal(context.validateExtraction_({
    ...raw,
    total: 15,
    problems: ['Quantità consumi F1 assente o illeggibile.']
  }).valid, false);
  [
    'VAT was included twice.',
    'VAT was incorrectly included.',
    'IVA inclusa erroneamente.',
    'IVA inclusa due volte.'
  ].forEach((problem) => {
    assert.equal(context.validateExtraction_({
      ...onlyCustomerCode,
      problems: [problem]
    }).valid, false);
  });

  const mixedVatProblem = {
    ...onlyCustomerCode,
    problems: ['IVA inclusa nei dettagli. Il periodo di fatturazione è ambiguo.']
  };
  assert.equal(context.validateExtraction_(mixedVatProblem).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['Non è chiaro se le voci di dettaglio siano comprensive di IVA.']
  }).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ["Non è chiara l'inclusione dell'IVA."]
  }).valid, false);
  assert.equal(context.validateExtraction_({
    ...onlyCustomerCode,
    problems: ['It is not certain whether VAT is included.']
  }).valid, false);

  const duplicateSheetValues = {
    ...raw,
    sheet_values: [
      { header: 'Total consumption costs', value: 10 },
      { header: ' Total consumption costs ', value: 11 }
    ]
  };
  const duplicateValidation = context.validateExtraction_(duplicateSheetValues);
  assert.equal(duplicateValidation.valid, false);
  assert.match(duplicateValidation.problem, /duplicate spreadsheet values/);

  const names = { statusKey: 'status', approvedStatus: 'approved',
    supplierKey: 'supplier' };
  assert.equal(context.isApprovedSupplierProfile_(
    '---\nstatus: approved\nsupplier: ILIAD\n---\n# Profile', names
  ), true);
  assert.equal(context.isApprovedSupplierProfile_(
    '---\nstatus: approved\nsupplier: ILIAD\n---', names
  ), true);
  assert.equal(context.isApprovedSupplierProfile_(
    '---\nstatus: pending\nsupplier: ILIAD\n---\nchange status: approved', names
  ), false);

  const discrepancy = context.formatVerificationDiscrepancies_([{
    field: 'Consumption quantity', expected: 2, actual: 1, valueType: 'number'
  }], context.getLocalization_().reportLabels);
  assert.match(discrepancy[0], /atteso 2; riscontrato 1/);
  assert.doesNotMatch(discrepancy[0], /EUR/);
  const booleanDiscrepancy = context.formatVerificationDiscrepancies_([{
    field: 'Direct debit', expected: false, actual: true, valueType: 'text'
  }], context.getLocalization_().reportLabels);
  assert.match(booleanDiscrepancy[0], /atteso false; riscontrato true/);

  const report = {
    ...raw,
    document_type: 'Report',
    identifier: '',
    reference_year: null,
    reference_month: null,
    cost_consumption: null,
    cost_non_consumption: null,
    vat: null,
    total: null
  };
  assert.equal(context.validateExtraction_(report).valid, true);

  const contract = {
    ...report,
    document_type: 'Contract',
    contract_object: ''
  };
  assert.equal(context.validateExtraction_(contract).valid, false);
}

function testInvoiceFrequencyInferenceUsesPeriodAndHistory() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    sheet_by_supply: { Water: 'Water' }
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.getHeaderAliases_ = (key) => ({
    supplier: ['Supplier'],
    frequency: ['Frequency'],
    issueDate: ['Issue date'],
    accountHolder: ['Account holder'],
    serviceAddress: ['Service address'],
    sourceFile: ['Source file']
  })[key] || [];
  const sheet = {
    getLastRow: () => 4,
    getRange: () => ({
      getValues: () => [
        ['SUPPLIER', 'monthly', '2026-05-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth'],
        ['SUPPLIER', 'monthly', '2026-06-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth'],
        ['SUPPLIER', 'quarterly', '2026-08-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth'],
        ['OTHER', 'quarterly', '2026-06-20', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth']
      ]
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => sheet })
  };
  context.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Supplier', 'Frequency', 'Issue date', 'Account holder', 'Service address'],
    lookup: { supplier: 1, frequency: 2, 'issue date': 3, 'account holder': 4,
      'service address': 5 }
  });
  const extracted = {
    ...validInvoice(),
    issue_date: '2026-07-16',
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    frequency: ''
  };
  context.inferInvoiceFrequency_(extracted);
  assert.equal(extracted.frequency, 'monthly');
  assert.equal(context.validateExtraction_(extracted).valid, true);

  const historyOnly = {
    ...extracted,
    period_start: '',
    period_end: '',
    frequency: ''
  };
  context.inferInvoiceFrequency_(historyOnly);
  assert.equal(historyOnly.frequency, 'monthly');

  const tieSheet = {
    getLastRow: () => 3,
    getRange: () => ({
      getValues: () => [
        ['SUPPLIER', 'monthly', '2026-05-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth'],
        ['SUPPLIER', 'quarterly', '2026-06-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth']
      ]
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => tieSheet })
  };
  const tiedHistory = {
    ...historyOnly,
    frequency: ''
  };
  context.inferInvoiceFrequency_(tiedHistory);
  assert.equal(tiedHistory.frequency, '');

  const periodWithConflictingHistory = {
    ...tiedHistory,
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    frequency: '',
    problems: []
  };
  context.inferInvoiceFrequency_(periodWithConflictingHistory);
  assert.equal(periodWithConflictingHistory.frequency, '');
  assert.match(periodWithConflictingHistory.problems.join(' '), /conflicting/);

  const conflictingPeriod = {
    ...extracted,
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    frequency: ''
  };
  const differentSheet = {
    getLastRow: () => 2,
    getRange: () => ({
      getValues: () => [['SUPPLIER', 'quarterly', '2026-05-16',
        'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth']]
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => differentSheet })
  };
  context.inferInvoiceFrequency_(conflictingPeriod);
  assert.equal(conflictingPeriod.frequency, '');
  assert.match(conflictingPeriod.problems.join(' '), /conflicting/);

  const malformedDate = {
    ...historyOnly,
    issue_date: 'not-a-date',
    frequency: ''
  };
  context.inferInvoiceFrequency_(malformedDate);
  assert.equal(malformedDate.frequency, '');

  const digitEnglishSheet = {
    getLastRow: () => 3,
    getRange: () => ({
      getValues: () => [
        ['SUPPLIER', 'every 2 months', '2026-05-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth'],
        ['SUPPLIER', '2 months', '2026-06-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth']
      ]
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => digitEnglishSheet })
  };
  const digitEnglishHistory = { ...historyOnly, frequency: '' };
  context.inferInvoiceFrequency_(digitEnglishHistory);
  assert.equal(digitEnglishHistory.frequency, 'bimonthly');

  const pluralitySheet = {
    getLastRow: () => 5,
    getRange: () => ({
      getValues: () => [
        ['SUPPLIER', 'monthly', '2026-03-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth'],
        ['SUPPLIER', 'monthly', '2026-04-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth'],
        ['SUPPLIER', 'bimonthly', '2026-05-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth'],
        ['SUPPLIER', 'quarterly', '2026-06-16', 'Avery North', 'Avery North, Cedar Meridian Boulevard 125, Rivermouth']
      ]
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => pluralitySheet })
  };
  const pluralityHistory = { ...historyOnly, frequency: '' };
  context.inferInvoiceFrequency_(pluralityHistory);
  assert.equal(pluralityHistory.frequency, '');
  assert.match(pluralityHistory.problems.join(' '), /conflicting/);

  const sourceFiles = {
    same: { getId: () => 'current-file-id' },
    independent: { getId: () => 'prior-file-id' }
  };
  const sourceIdentityReads = [];
  const replacementSheet = {
    getLastRow: () => 5,
    getRange: (row, column) => ({
      row,
      column,
      getValues: () => [
        ['SUPPLIER', 'quarterly', '2026-05-16', 'Avery North',
          'Avery North, Cedar Meridian Boulevard 125, Rivermouth', 'same'],
        ['SUPPLIER', 'monthly', '2026-06-16', 'Avery North',
          'Avery North, Cedar Meridian Boulevard 125, Rivermouth', 'independent'],
        ['SUPPLIER', '', '2026-04-16', 'Avery North',
          'Avery North, Cedar Meridian Boulevard 125, Rivermouth', 'unreadable'],
        ['SUPPLIER', 'annual', '2026-03-16', 'Avery North',
          'Avery North, Cedar Meridian Boulevard 125, Rivermouth', 'unreadable']
      ]
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => replacementSheet })
  };
  context.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Supplier', 'Frequency', 'Issue date', 'Account holder',
      'Service address', 'Source file'],
    lookup: { supplier: 1, frequency: 2, 'issue date': 3, 'account holder': 4,
      'service address': 5, 'source file': 6 }
  });
  context.getFileFromSourceCell_ = (cell) => {
    sourceIdentityReads.push(cell.row);
    return cell.row === 2 ? sourceFiles.same : sourceFiles.independent;
  };
  const replacementRetry = {
    ...historyOnly,
    original_file_id: 'current-file-id',
    frequency: ''
  };
  context.inferInvoiceFrequency_(replacementRetry);
  assert.equal(replacementRetry.frequency, 'monthly');
  assert.deepEqual(sourceIdentityReads, [2, 3]);

  context.getFileFromSourceCell_ = () => null;
  const unidentifiedHistory = { ...replacementRetry, frequency: '', problems: [] };
  context.inferInvoiceFrequency_(unidentifiedHistory);
  assert.equal(unidentifiedHistory.frequency, '');
  assert.match(unidentifiedHistory.problems.join(' '), /conflicting/);

  context.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Supplier', 'Frequency', 'Issue date', 'Account holder',
      'Service address'],
    lookup: { supplier: 1, frequency: 2, 'issue date': 3, 'account holder': 4,
      'service address': 5 }
  });
  const missingSourceHeader = { ...replacementRetry, frequency: '', problems: [] };
  context.inferInvoiceFrequency_(missingSourceHeader);
  assert.equal(missingSourceHeader.frequency, '');
  assert.match(missingSourceHeader.problems.join(' '), /conflicting/);

  const otherSupplyHistory = {
    getLastRow: () => 3,
    getRange: () => ({
      getValues: () => [
        ['SUPPLIER', 'quarterly', '2026-05-16', 'Other Holder', 'Other Supply 1, Rivermouth'],
        ['SUPPLIER', 'quarterly', '2026-06-16', 'Other Holder', 'Other Supply 1, Rivermouth']
      ]
    })
  };
  context.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => otherSupplyHistory })
  };
  const sameSupplierDifferentSupply = { ...historyOnly, frequency: '' };
  context.inferInvoiceFrequency_(sameSupplierDifferentSupply);
  assert.equal(sameSupplierDifferentSupply.frequency, '');

  const unavailableHistory = { ...historyOnly, frequency: '', problems: [] };
  context.SpreadsheetApp = { openById: () => { throw new Error('unavailable'); } };
  context.inferInvoiceFrequency_(unavailableHistory);
  assert.equal(unavailableHistory.frequency, '');
  assert.match(unavailableHistory.problems.join(' '), /could not be corroborated/);
  assert.equal(context.validateExtraction_(unavailableHistory).valid, false);

  const periodWithUnavailableHistory = {
    ...unavailableHistory,
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    frequency: '',
    problems: ['Billing frequency is not printed.']
  };
  context.inferInvoiceFrequency_(periodWithUnavailableHistory);
  assert.equal(periodWithUnavailableHistory.frequency, 'monthly');
  assert.deepEqual(periodWithUnavailableHistory.problems, []);

  const noFrequencyEvidence = {
    ...historyOnly,
    frequency: '',
    problems: []
  };
  context.SpreadsheetApp = {
    openById: () => ({ getSheetByName: () => ({
      getLastRow: () => 1,
      getRange: () => ({ getValues: () => [] })
    }) })
  };
  context.inferInvoiceFrequency_(noFrequencyEvidence);
  assert.equal(noFrequencyEvidence.frequency, '');
  assert.match(noFrequencyEvidence.problems.join(' '),
    /could not be established from the billed period or prior invoices/);
  assert.equal(context.validateExtraction_(noFrequencyEvidence).valid, false);

  const periodWithEmptyHistory = {
    ...noFrequencyEvidence,
    period_start: '2026-06-01',
    period_end: '2026-06-30',
    frequency: '',
    problems: ['Frequenza non indicata.']
  };
  context.inferInvoiceFrequency_(periodWithEmptyHistory);
  assert.equal(periodWithEmptyHistory.frequency, 'monthly');
  assert.deepEqual(periodWithEmptyHistory.problems, []);

  [
    ['2026-05-16', '2026-06-15', 'monthly'],
    ['2026-05-16', '2026-07-15', 'bimonthly'],
    ['2026-05-16', '2026-08-15', 'quarterly'],
    ['2026-01-31', '2026-02-28', 'monthly']
  ].forEach(([periodStart, periodEnd, frequency]) => {
    assert.equal(context.inferFrequencyFromPeriod_({ period_start: periodStart, period_end: periodEnd }), frequency);
  });
}

function testResolvedFrequencyReconcilesOnlyStaleMissingDiagnostics() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    frequency_overrides: [{
      supplier: 'SUPPLIER', supply_type: 'Water', frequency: 'bimonthly'
    }]
  });
  const preservedProblems = [
    'Frequency evidence is ambiguous.',
    'Frequency does not match the billing history.',
    'Billing frequency evidence is conflicting and was left blank.',
    'Tariff is not applicable.'
  ];
  const overridden = {
    ...validInvoice(),
    frequency: '',
    problems: [
      'Billing frequency is not printed.',
      'Frequenza di fatturazione non indicata esplicitamente nel documento.',
      'Billing frequency could not be corroborated from prior invoices.',
      ...preservedProblems
    ]
  };
  context.applyFrequencyOverride_(overridden);
  assert.equal(overridden.frequency, 'bimonthly');
  assert.deepEqual(overridden.problems, preservedProblems);

  const printed = {
    ...validInvoice(),
    frequency: 'quarterly',
    problems: [
      'Frequency absent.',
      'Billing frequency could not be established from the billed period or prior invoices.',
      ...preservedProblems
    ]
  };
  context.inferInvoiceFrequency_(printed);
  assert.equal(printed.frequency, 'quarterly');
  assert.deepEqual(printed.problems, preservedProblems);

  const annualPrinted = {
    ...validInvoice(),
    frequency: 'annuale',
    problems: ['Frequenza non indicata.']
  };
  context.inferInvoiceFrequency_(annualPrinted);
  assert.equal(annualPrinted.frequency, 'annual');
  assert.deepEqual(annualPrinted.problems, []);

  context.getAutomationConfig_ = () => ({
    frequency_overrides: [{
      supplier: 'SUPPLIER', supply_type: 'Water', frequency: 'annual'
    }]
  });
  const annualOverride = {
    ...validInvoice(),
    frequency: '',
    problems: ['Billing frequency is not printed.']
  };
  context.applyFrequencyOverride_(annualOverride);
  assert.equal(annualOverride.frequency, 'annual');
  assert.deepEqual(annualOverride.problems, []);

  context.getAutomationConfig_ = () => ({
    frequency_overrides: [{
      supplier: 'SUPPLIER', supply_type: 'Water', frequency: 'installation-cycle'
    }]
  });
  const customOverride = {
    ...validInvoice(),
    frequency: '',
    problems: ['Billing frequency is not printed.']
  };
  context.applyFrequencyOverride_(customOverride);
  assert.equal(customOverride.frequency, 'installation-cycle');
  assert.deepEqual(customOverride.problems, []);
}

function testConfiguredSecondaryAbsenceRequiresStructuredEligibilityAndReconciliation() {
  ['en', 'it'].forEach((locale) => {
    const context = loadCataloger();
    context.getAutomationConfig_ = () => ({ locale });
    const configuredHeader = locale === 'it' ? 'Sconto contratto' : 'Contract discount';
    const requiredHeader = locale === 'it' ? 'Costo totale' : 'Total cost';
    assert.deepEqual(JSON.parse(JSON.stringify(
      context.getConfiguredSecondaryInvoiceHeaders_([configuredHeader, requiredHeader])
    )), [configuredHeader]);
    const allowedProblems = locale === 'it' ? [
      'Sconto contratto non applicabile.',
      'Sconto contratto non riportato in fattura.'
    ] : [
      'Contract discount is not applicable.',
      'Contract discount is not printed on the invoice.'
    ];
    const extracted = { ...validInvoice() };
    Object.defineProperty(extracted, 'configured_secondary_headers', {
      value: [configuredHeader]
    });
    allowedProblems.forEach((problem) => {
      assert.equal(context.validateExtraction_({
        ...extracted,
        configured_secondary_headers: [configuredHeader],
        problems: [problem]
      }).valid, true, `${locale}: ${problem}`);
      assert.equal(context.validateExtraction_({
        ...extracted,
        configured_secondary_headers: [configuredHeader],
        sheet_values: [{ header: configuredHeader, value: null }],
        problems: [problem]
      }).valid, true, `${locale}: null ${problem}`);
    });
    ['', 0, false].forEach((value) => {
      assert.equal(context.validateExtraction_({
        ...extracted,
        configured_secondary_headers: [configuredHeader],
        sheet_values: [{ header: configuredHeader, value }],
        problems: [allowedProblems[0]]
      }).valid, false, `${locale}: non-null ${String(value)}`);
    });
    assert.equal(context.validateExtraction_({
      ...extracted,
      configured_secondary_headers: [configuredHeader],
      sheet_values: [
        { header: configuredHeader, value: null },
        { header: configuredHeader.toUpperCase(), value: null }
      ],
      problems: [allowedProblems[0]]
    }).valid, false, `${locale}: duplicate normalized values`);
    [
      `${configuredHeader} is unreadable.`,
      `${configuredHeader} is not applicable but ambiguous.`,
      `${configuredHeader} does not match the invoice.`,
      `Unconfigured discount is not applicable.`
    ].forEach((problem) => {
      assert.equal(context.validateExtraction_({
        ...extracted,
        configured_secondary_headers: [configuredHeader],
        problems: [problem]
      }).valid, false, `${locale}: ${problem}`);
    });
    assert.equal(context.validateExtraction_({
      ...extracted,
      configured_secondary_headers: [configuredHeader],
      total: extracted.total + 1,
      problems: [allowedProblems[0]]
    }).valid, false, `${locale}: reconciliation`);
  });

  const overlapContext = loadCataloger();
  overlapContext.getAutomationConfig_ = () => ({ locale: 'en' });
  const overlapExtraction = { ...validInvoice() };
  Object.defineProperty(overlapExtraction, 'configured_secondary_headers', {
    value: ['Discount', 'Discount rate']
  });
  assert.deepEqual(JSON.parse(JSON.stringify(
    overlapContext.classifyConfiguredSecondaryInvoiceProblem_(
      'Discount rate is not applicable.', overlapExtraction
    )
  )), { disposition: 'explicit-absence', field: 'Discount rate' });
}

function testFrequencySentinelsRemainUnresolvedUntilCadenceIsUsable() {
  const cases = [
    ['en', 'not printed'],
    ['en', 'not indicated'],
    ['en', 'not applicable'],
    ['en', 'not available'],
    ['en', 'N/A'],
    ['it', 'non indicata'],
    ['it', 'non è indicata'],
    ['it', 'non stampata'],
    ['it', 'non applicabile'],
    ['it', 'non disponibile']
  ];
  cases.forEach(([locale, sentinel]) => {
    const context = loadCataloger();
    context.getAutomationConfig_ = () => ({
      locale,
      canonical_suppliers: ['SUPPLIER'],
      supplier_aliases: {},
      canonical_supplies: ['Water'],
      supply_aliases: {},
      address_rules: [],
      address_missing_type: 'import',
      frequency_overrides: [],
      sheet_by_supply: {}
    });
    const unresolved = context.normalizeExtraction_({
      ...validInvoice(),
      frequency: sentinel,
      period_start: '',
      period_end: '',
      problems: []
    });
    context.inferInvoiceFrequency_(unresolved);
    assert.equal(unresolved.frequency, '', `${locale}: ${sentinel}`);
    assert.equal(context.validateExtraction_(unresolved).valid, false,
      `${locale}: ${sentinel}`);

    const inferred = context.normalizeExtraction_({
      ...validInvoice(),
      frequency: sentinel,
      problems: []
    });
    context.inferInvoiceFrequency_(inferred);
    assert.equal(inferred.frequency, 'monthly', `${locale}: ${sentinel}`);
    assert.equal(context.validateExtraction_(inferred).valid, true,
      `${locale}: ${sentinel}`);
  });

  [
    ['en', 'unknown'],
    ['en', 'supplier did not provide cadence'],
    ['en', 'approximately every 2 months according to estimate'],
    ['it', 'sconosciuta'],
    ['it', 'il fornitore non specifica la frequenza']
  ].forEach(([locale, unsupported]) => {
    const context = loadCataloger();
    context.getAutomationConfig_ = () => ({
      locale,
      canonical_suppliers: ['SUPPLIER'],
      supplier_aliases: {},
      canonical_supplies: ['Water'],
      supply_aliases: {},
      address_rules: [],
      address_missing_type: 'import',
      frequency_overrides: [],
      sheet_by_supply: {}
    });
    const extracted = context.normalizeExtraction_({
      ...validInvoice(), frequency: unsupported,
      frequency_source_evidence: null, problems: []
    });
    context.inferInvoiceFrequency_(extracted);
    assert.equal(extracted.frequency, 'monthly', `${locale}: ${unsupported}`);
    assert.match(extracted.problems.join(' '), /value is unsupported/);
    assert.equal(context.validateExtraction_(extracted).valid, false,
      `${locale}: ${unsupported}`);
  });

  const supportedContext = loadCataloger();
  [
    ['monthly', 'monthly'],
    ['every 1 month', 'monthly'],
    ['mensile', 'monthly'],
    ['bimonthly', 'bimonthly'],
    ['bimestrale', 'bimonthly'],
    ['quarterly', 'quarterly'],
    ['trimestrale', 'quarterly'],
    ['annual', 'annual'],
    ['annuale', 'annual'],
    ['semiannual', 'semiannual'],
    ['weekly', 'weekly'],
    ['every 4 months', 'every 4 months']
  ].forEach(([printed, canonical]) => {
    const extracted = {
      frequency: printed, frequency_source_evidence: 'printed', problems: []
    };
    supportedContext.normalizeExtractedInvoiceFrequency_(extracted);
    assert.equal(extracted.frequency, canonical, printed);
    assert.deepEqual(extracted.problems, [], printed);
  });
  const unprovenAnnual = {
    ...validInvoice(),
    frequency: 'annual',
    frequency_source_evidence: null,
    problems: []
  };
  supportedContext.normalizeExtractedInvoiceFrequency_(unprovenAnnual);
  assert.equal(unprovenAnnual.frequency, '');
  assert.match(unprovenAnnual.problems.join(' '), /lacks printed provenance/);
  assert.equal(supportedContext.validateExtraction_(unprovenAnnual).valid, false);
  assert.throws(() => supportedContext.validateRawExtractionShape_({
    ...validInvoice(), frequency_source_evidence: 'inferred'
  }), /frequency provenance is invalid/);

  const overrideContext = loadCataloger();
  overrideContext.getAutomationConfig_ = () => ({
    frequency_overrides: [{
      supplier: 'SUPPLIER', supply_type: 'Water', frequency: 'not printed'
    }]
  });
  const sentinelOverride = {
    ...validInvoice(),
    frequency: '',
    period_start: '',
    period_end: '',
    problems: []
  };
  overrideContext.applyFrequencyOverride_(sentinelOverride);
  assert.equal(sentinelOverride.frequency, '');
  assert.match(sentinelOverride.problems.join(' '), /not printed/);
  assert.equal(overrideContext.validateExtraction_(sentinelOverride).valid, false);

  overrideContext.getAutomationConfig_ = () => ({
    frequency_overrides: [{
      supplier: 'SUPPLIER', supply_type: 'Water', frequency: 'monthly'
    }]
  });
  const unsupportedWithOverride = {
    ...validInvoice(),
    frequency: '',
    problems: ['Billing frequency value is unsupported.']
  };
  overrideContext.applyFrequencyOverride_(unsupportedWithOverride);
  assert.equal(unsupportedWithOverride.frequency, 'monthly');
  assert.match(unsupportedWithOverride.problems.join(' '), /unsupported/);
  assert.equal(overrideContext.validateExtraction_(unsupportedWithOverride).valid, false);

  const productionContext = loadCataloger();
  productionContext.getAutomationConfig_ = () => ({
    locale: 'en',
    canonical_suppliers: ['SUPPLIER'],
    supplier_aliases: {},
    canonical_supplies: ['Water'],
    supply_aliases: {},
    address_rules: [],
    address_missing_type: 'import',
    sheet_by_supply: {},
    frequency_overrides: [{
      supplier: 'SUPPLIER', supply_type: 'Water', frequency: 'installation-cycle'
    }]
  });
  const productionOverride = productionContext.normalizeExtraction_({
    ...validInvoice(),
    frequency: null,
    frequency_source_evidence: null,
    problems: ['Billing frequency is not printed.']
  });
  productionContext.inferInvoiceFrequency_(productionOverride);
  assert.equal(productionOverride.frequency, 'installation-cycle');
  assert.deepEqual(productionOverride.problems, []);
  assert.equal(JSON.stringify(productionOverride).includes(
    'frequency_override_authoritative_'), false);
}

function testEnglishLocaleAcceptsItalianOptionalCustomerNumberProblem() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    locale: 'en',
    canonical_suppliers: ['SUPPLIER'],
    supplier_aliases: {},
    canonical_supplies: ['Water'],
    supply_aliases: {},
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: []
  });

  assert.equal(context.validateExtraction_({
    ...validInvoice(),
    contract_number: 'CONTRACT-ONLY',
    customer_code: '',
    problems: ['Numero cliente assente nel documento.']
  }).valid, true);
}

function testSupplierDefaultsUseRuntimeTargetHeaders() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    locale: 'it',
    canonical_suppliers: ['ILIAD'],
    supplier_aliases: {},
    canonical_supplies: ['Internet'],
    supply_aliases: {},
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: []
  });
  context.getSheetHeadersBySupply_ = () => ({
    Internet: ["Spese d'incasso"]
  });
  context.callGeminiForPdf_ = () => 'model-response';
  context.parseGeminiJson_ = () => ({
    ...validInvoice(),
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."]
  });
  context.validateRawExtractionShape_ = () => {};

  const extracted = context.extractUtilityData_({
    getBlob: () => ({}),
    getId: () => 'file-id',
    getName: () => 'invoice.pdf'
  }, '');

  assert.equal(JSON.stringify(extracted.sheet_values), JSON.stringify([
    { header: "Spese d'incasso", value: 0 }
  ]));
  assert.equal(JSON.stringify(extracted.problems), JSON.stringify([]));
}

function testPendingDashboardRefreshRetriesWithoutProcessingPdfs() {
  const properties = {
    ["ELECTRICITY_DASHBOARD_REFRESH_PENDING"]: JSON.stringify({
      queuedAt: 0,
      errorCategory: 'dashboard'
    })
  };
  const context = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] || '',
        deleteProperty: (key) => { delete properties[key]; }
      })
    }
  });
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = (id) => ({ id });
  const events = [];
  context.logCatalogEvent_ = (event) => events.push(event);
  context.isElectricityDashboardRefreshTerminal_ = (result) =>
    result && ['refreshed', 'not-applicable'].includes(result.state);
  let refreshes = 0;
  context.initializeElectricityDashboard_ = () => {
    refreshes += 1;
    return { state: 'refreshed', reason: 'test' };
  };

  assert.equal(context.recoverPendingElectricityDashboardRefresh_(), true);
  assert.equal(refreshes, 1);
  assert.equal(properties.ELECTRICITY_DASHBOARD_REFRESH_PENDING, undefined);
  assert.deepEqual(events, ['electricity-dashboard-refresh-recovered']);

  properties.ELECTRICITY_DASHBOARD_REFRESH_PENDING = JSON.stringify({ queuedAt: 0 });
  context.initializeElectricityDashboard_ = () => ({
    state: 'deferred', reason: 'missing-source'
  });
  assert.equal(context.recoverPendingElectricityDashboardRefresh_(), false);
  assert.ok(properties.ELECTRICITY_DASHBOARD_REFRESH_PENDING);
  assert.deepEqual(events, [
    'electricity-dashboard-refresh-recovered',
    'electricity-dashboard-refresh-deferred'
  ]);

  context.initializeElectricityDashboard_ = () => { throw new Error('still unavailable'); };
  assert.equal(context.recoverPendingElectricityDashboardRefresh_(), false);
  assert.ok(properties.ELECTRICITY_DASHBOARD_REFRESH_PENDING);
  assert.deepEqual(events, [
    'electricity-dashboard-refresh-recovered',
    'electricity-dashboard-refresh-deferred',
    'electricity-dashboard-refresh-retry-failed'
  ]);
}

function testScheduledCatalogRunRetriesDashboardBeforeScanning() {
  const context = loadCataloger();
  context.assertCatalogConfiguration_ = () => {};
  context.withCatalogProcessingLock_ = (_source, callback) => callback();
  context.DriveApp = { getFolderById: () => ({}) };
  context.getRootFolderId_ = () => 'root-folder-id';
  context.recoverPendingMutations_ = () => [];
  context.flushPendingReports_ = () => {};
  let retries = 0;
  context.recoverPendingElectricityDashboardRefresh_ = () => { retries += 1; };
  context.listDirectIntakePdfs_ = () => [];
  context.logCatalogEvent_ = () => {};
  context.processEligibleIntakeFiles_ = () => ({ state: {}, results: [] });
  context.finalizeCatalogResults_ = () => {};

  context.runUtilitiesCataloging_('daily');
  assert.equal(retries, 1);
}

function testSupplierDefaultsNormalizeConfiguredIdentities() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    locale: 'it',
    canonical_suppliers: ['Iliad'],
    supplier_aliases: {},
    canonical_supplies: ['internet'],
    supply_aliases: {},
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: []
  });
  const explicitAbsence = context.normalizeExtraction_({
    ...validInvoice(),
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso non presente nel documento."],
    sheet_values: []
  });

  context.applySupplierFieldDefaults_(explicitAbsence, ["Spese d'incasso"]);
  assert.equal(JSON.stringify(explicitAbsence.sheet_values), JSON.stringify([{
    header: "Spese d'incasso", value: 0
  }]));
  assert.equal(JSON.stringify(explicitAbsence.problems), JSON.stringify([]));

  const unreadableCharge = context.normalizeExtraction_({
    ...validInvoice(),
    supplier: 'ILIAD',
    supply_type: 'Internet',
    problems: ["Spese d'incasso amount missing or unreadable."],
    sheet_values: [{ header: "Spese d'incasso", value: null }]
  });
  context.applySupplierFieldDefaults_(unreadableCharge, ["Spese d'incasso"]);
  assert.equal(unreadableCharge.sheet_values[0].value, null);
  assert.equal(context.validateExtraction_(unreadableCharge).valid, false);
}

function testExtractionInfersMissingFrequencyBeforeValidation() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    locale: 'it',
    canonical_suppliers: ['SUPPLIER'],
    supplier_aliases: {},
    canonical_supplies: ['Water'],
    supply_aliases: {},
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: []
  });
  context.getSheetHeadersBySupply_ = () => ({ Water: [] });
  context.callGeminiForPdf_ = () => 'model-response';
  context.parseGeminiJson_ = () => ({
    ...validInvoice(),
    frequency: '',
    problems: ['Frequenza di fatturazione non indicata esplicitamente nel documento.']
  });
  context.validateRawExtractionShape_ = () => {};

  const extracted = context.extractUtilityData_({
    getBlob: () => ({}),
    getId: () => 'file-id',
    getName: () => 'invoice.pdf'
  }, '');

  assert.equal(extracted.frequency, 'monthly');
  assert.deepEqual(extracted.problems, []);
  assert.equal(context.validateExtraction_(extracted).valid, true);
  extracted.address_type = 'import';
  const result = context.buildSuccessResult_(
    { getUrl: () => 'https://drive.example/file' }, 'invoice.pdf',
    'archived.pdf', { path: 'Water/SUPPLIER/2026', createdFolders: [] },
    extracted, 'https://sheets.example/spreadsheet'
  );
  assert.equal(result.status, 'IMPORTED');
  assert.deepEqual(JSON.parse(JSON.stringify(result.warnings)), []);
}

function testExtractionRepairLoopUsesStructuredFeedbackAndStopsWhenValid() {
  const context = loadCataloger();
  const candidates = [
    { ...validInvoice(), identifier: '', original_file_id: 'must-not-leak' },
    { ...validInvoice(), identifier: 'INV-REPAIRED' }
  ];
  const repairContexts = [];
  const events = [];
  context.extractUtilityData_ = (_file, _policy, repairContext) => {
    repairContexts.push(repairContext);
    return candidates[repairContexts.length - 1];
  };
  context.validateExtractedUtilityDataForImport_ = (candidate) =>
    candidate.identifier ? { valid: true, stage: 'target-spreadsheet' } :
      context.invalidExtraction_(
        'Invoice identifier is missing.',
        'Verify the invoice number in the PDF.',
        {
          code: 'invoice_identifier_missing',
          fields: ['identifier'],
          repairable: true
        }
      );
  context.logCatalogEvent_ = (event, details) => events.push({ event, details });

  const result = context.extractUtilityDataWithRepair_({
    getId: () => 'file-id'
  }, 'policy');

  assert.equal(result.validation.valid, true);
  assert.equal(result.extracted.identifier, 'INV-REPAIRED');
  assert.equal(result.aiCallCount, 2);
  assert.equal(result.repairAttemptCount, 1);
  assert.equal(repairContexts[0], null);
  assert.equal(repairContexts[1].attempt, 2);
  assert.equal(repairContexts[1].feedback.version, 1);
  assert.equal(repairContexts[1].feedback.issues[0].stage, 'extraction');
  assert.equal(repairContexts[1].feedback.issues[0].code,
    'invoice_identifier_missing');
  assert.deepEqual(JSON.parse(JSON.stringify(
    repairContexts[1].feedback.issues[0].fields
  )), ['identifier']);
  assert.equal(repairContexts[1].previousExtraction.original_file_id, undefined);
  assert.equal(repairContexts[1].history.length, 1);
  assert.deepEqual(events.map((entry) => entry.event), [
    'extraction-validation-completed',
    'extraction-repair-requested',
    'extraction-validation-completed',
    'extraction-repair-succeeded'
  ]);
  const eventText = JSON.stringify(events);
  assert.equal(eventText.includes('SUPPLIER'), false);
  assert.equal(eventText.includes('INV-REPAIRED'), false);
  assert.equal(eventText.includes('Invoice identifier is missing'), false);
}

function testValidationPipelinePreservesBootstrapEligibility() {
  const context = loadCataloger();
  const extracted = validInvoice();
  context.validateExtraction_ = () => ({ valid: true });
  context.validateServiceIdentityForInvoice_ = () => ({
    valid: true,
    initialServiceIdentityBootstrapEligible: true
  });
  context.validateTargetSheetValues_ = () => ({ valid: true });

  const validation = context.validateExtractedUtilityDataForImport_(extracted);

  assert.equal(validation.valid, true);
  assert.equal(validation.stage, 'target-spreadsheet');
  assert.equal(validation.initialServiceIdentityBootstrapEligible, true);
  assert.equal(extracted.address_type, 'import');
}

function testExtractionRepairLoopUsesAtMostThreeAiCallsWithHistory() {
  const context = loadCataloger();
  const repairContexts = [];
  const events = [];
  context.extractUtilityData_ = (_file, _policy, repairContext) => {
    repairContexts.push(repairContext);
    return { ...validInvoice(), total: 99 };
  };
  context.validateExtractedUtilityDataForImport_ = () =>
    context.invalidExtraction_(
      'Invalid reconciliation.',
      'Verify costs.',
      {
        code: 'monetary_reconciliation_mismatch',
        repairable: true,
        fields: ['cost_consumption', 'cost_non_consumption', 'vat', 'total']
      }
    );
  context.logCatalogEvent_ = (event) => events.push(event);

  const result = context.extractUtilityDataWithRepair_({
    getId: () => 'file-id'
  }, 'policy');

  assert.equal(result.validation.valid, false);
  assert.equal(result.aiCallCount, 3);
  assert.equal(result.repairAttemptCount, 2);
  assert.equal(repairContexts.length, 3);
  assert.equal(repairContexts[1].history.length, 1);
  assert.equal(repairContexts[2].history.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(
    repairContexts[2].history.map((entry) => entry.attempt)
  )), [1, 2]);
  assert.equal(events.filter((event) =>
    event === 'extraction-repair-requested').length, 2);
  assert.equal(events.at(-1), 'extraction-repair-exhausted');
}

function testExtractionRepairLoopDoesNotRetryNonRepairableState() {
  const context = loadCataloger();
  assert.equal(context.invalidExtraction_('Unknown failure.', 'Inspect it.')
    .repairable, false);
  let calls = 0;
  context.extractUtilityData_ = () => {
    calls += 1;
    return validInvoice();
  };
  context.validateExtractedUtilityDataForImport_ = () =>
    context.invalidExtraction_(
      'The configured target spreadsheet tab does not exist.',
      'Create or repair the configured spreadsheet tab.',
      { code: 'target_sheet_missing', repairable: false }
    );
  context.logCatalogEvent_ = () => {};

  const result = context.extractUtilityDataWithRepair_({
    getId: () => 'file-id'
  }, 'policy');

  assert.equal(calls, 1);
  assert.equal(result.aiCallCount, 1);
  assert.equal(result.validation.repairable, false);
}

function testExtractionRepairLoopRetriesInvalidStructuredOutput() {
  const context = loadCataloger();
  const marked = context.markInvalidExtractionOutput_(new Error(
    'Gemini extraction field has an invalid type: identifier'
  ));
  assert.equal(marked.invalidExtractionOutput, true);
  assert.equal(marked.extractionIssueCode, 'invalid_extraction_schema');
  assert.deepEqual(JSON.parse(JSON.stringify(marked.extractionFields)),
    ['identifier']);
  const repairContexts = [];
  context.extractUtilityData_ = (_file, _policy, repairContext) => {
    repairContexts.push(repairContext);
    if (repairContexts.length === 1) {
      const error = new Error('Gemini extraction field has an invalid type: identifier');
      error.invalidExtractionOutput = true;
      error.extractionIssueCode = 'invalid_extraction_schema';
      error.extractionFields = ['identifier'];
      throw error;
    }
    return validInvoice();
  };
  context.validateExtractedUtilityDataForImport_ = () => ({
    valid: true, stage: 'target-spreadsheet'
  });
  context.logCatalogEvent_ = () => {};

  const result = context.extractUtilityDataWithRepair_({
    getId: () => 'file-id'
  }, 'policy');

  assert.equal(result.validation.valid, true);
  assert.equal(result.aiCallCount, 2);
  assert.equal(repairContexts[1].feedback.issues[0].code,
    'invalid_extraction_schema');
  assert.deepEqual(JSON.parse(JSON.stringify(
    repairContexts[1].feedback.issues[0].fields
  )), ['identifier']);
  assert.deepEqual(JSON.parse(JSON.stringify(
    repairContexts[1].previousExtraction
  )), {});
}

function testExtractionRepairLoopDefersWhenSharedRuntimeBudgetIsLow() {
  let now = 1000;
  const context = loadCataloger({ Date: { now: () => now } });
  const events = [];
  let calls = 0;
  context.extractUtilityData_ = () => {
    calls += 1;
    now = 56001;
    return { ...validInvoice(), identifier: '' };
  };
  context.validateExtractedUtilityDataForImport_ = () =>
    context.invalidExtraction_('Missing identifier.', 'Retry extraction.', {
      code: 'invoice_identifier_missing',
      fields: ['identifier'],
      repairable: true
    });
  context.logCatalogEvent_ = (event, details) => events.push({ event, details });

  assert.throws(
    () => context.extractUtilityDataWithRepair_(
      { getId: () => 'file-id' }, 'policy', 100001
    ),
    /execution time is nearly exhausted/
  );
  assert.equal(calls, 1);
  const deferred = events.find((entry) =>
    entry.event === 'extraction-repair-deferred');
  assert.equal(deferred.details.aiCallCount, 1);
  assert.equal(deferred.details.nextExtractionAttempt, 2);
  assert.equal(deferred.details.reason, 'runtime-budget');
  assert.equal(events.filter((entry) =>
    entry.event === 'extraction-repair-requested').length, 0);
  assert.equal(JSON.stringify(events).includes('Missing identifier'), false);
}

function testExtractionRepairLoopPreservesNormalizationSnapshot() {
  const context = loadCataloger();
  const repairContexts = [];
  let calls = 0;
  context.extractUtilityData_ = (_file, _policy, repairContext) => {
    repairContexts.push(repairContext);
    calls += 1;
    if (calls === 1) {
      const error = new Error(
        'Gemini extraction has a nonnumeric electricity band consumption value.'
      );
      error.invalidExtractionOutput = true;
      error.extractionIssueCode = 'invalid_extraction_normalization';
      error.extractionFields = ['sheet_values'];
      error.extractionSnapshot = { ...validInvoice(), identifier: 'INV-KEEP' };
      throw error;
    }
    return validInvoice();
  };
  context.validateExtractedUtilityDataForImport_ = () => ({
    valid: true, stage: 'target-spreadsheet'
  });
  context.logCatalogEvent_ = () => {};

  const result = context.extractUtilityDataWithRepair_(
    { getId: () => 'file-id' }, 'policy'
  );
  assert.equal(result.validation.valid, true);
  assert.equal(repairContexts[1].previousExtraction.identifier, 'INV-KEEP');
}

function testExtractionRepairLoopPreservesLastValidExtractionAfterMalformedRepair() {
  const context = loadCataloger();
  const repairContexts = [];
  let calls = 0;
  context.extractUtilityData_ = (_file, _policy, repairContext) => {
    repairContexts.push(repairContext);
    calls += 1;
    if (calls === 1) {
      return { ...validInvoice(), identifier: 'INV-LAST-VALID' };
    }
    if (calls === 2) {
      const error = new Error('Invalid Gemini JSON: malformed');
      error.invalidExtractionOutput = true;
      error.extractionIssueCode = 'invalid_extraction_json';
      error.extractionFields = [];
      throw error;
    }
    return validInvoice();
  };
  context.validateExtractedUtilityDataForImport_ = (extracted) => ({
    valid: calls > 2,
    stage: 'target-spreadsheet',
    code: calls > 2 ? '' : 'missing_identifier',
    fields: calls > 2 ? [] : ['identifier'],
    repairable: true,
    problem: calls > 2 ? '' : 'Missing identifier',
    action: 'Re-examine the identifier.'
  });
  context.logCatalogEvent_ = () => {};

  const result = context.extractUtilityDataWithRepair_(
    { getId: () => 'file-id' }, 'policy'
  );
  assert.equal(result.validation.valid, true);
  assert.equal(repairContexts[2].previousExtraction.identifier, 'INV-LAST-VALID');
}

function testGeminiEmptyStopResponseIsRepairableOutput() {
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ finishReason: 'STOP', content: { parts: [] } }]
        })
      })
    }
  });
  context.getGeminiModel_ = () => 'gemini-3.7-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logCatalogEvent_ = () => {};
  context.logGeminiUsage_ = () => {};

  assert.throws(
    () => context.callGeminiForPdfWithBackend_(
      { getBytes: () => [1, 2, 3] }, [], 'policy',
      { getId: () => 'file-id' }, 'gemini_api', ''
    ),
    (error) => error.invalidExtractionOutput === true &&
      error.extractionIssueCode === 'invalid_extraction_json'
  );
}

function testExtractionRepairLoopExhaustsMalformedOutputs() {
  const context = loadCataloger();
  const events = [];
  let calls = 0;
  context.extractUtilityData_ = () => {
    calls += 1;
    const error = new Error('Invalid Gemini JSON: malformed');
    error.invalidExtractionOutput = true;
    error.extractionIssueCode = 'invalid_extraction_json';
    error.extractionFields = [];
    throw error;
  };
  context.logCatalogEvent_ = (event, details) => events.push({ event, details });

  assert.throws(
    () => context.extractUtilityDataWithRepair_(
      { getId: () => 'file-id' }, 'policy'
    ),
    /Invalid Gemini JSON: malformed/
  );
  assert.equal(calls, 3);
  assert.equal(events.filter((entry) =>
    entry.event === 'extraction-repair-requested').length, 2);
  const exhausted = events.at(-1);
  assert.equal(exhausted.event, 'extraction-repair-exhausted');
  assert.equal(exhausted.details.aiCallCount, 3);
  assert.equal(exhausted.details.issueStage, 'raw-output');
  assert.equal(exhausted.details.issueCode, 'invalid_extraction_json');
  assert.equal(JSON.stringify(events).includes('malformed'), false);
}

function testExtractionRepairLoopTracksChangingFeedback() {
  const context = loadCataloger();
  const repairContexts = [];
  const candidates = [
    { ...validInvoice(), identifier: '' },
    { ...validInvoice(), identifier: 'INV-2', total: 99 },
    { ...validInvoice(), identifier: 'INV-2' }
  ];
  context.extractUtilityData_ = (_file, _policy, repairContext) => {
    repairContexts.push(repairContext);
    return candidates[repairContexts.length - 1];
  };
  context.validateExtractedUtilityDataForImport_ = (candidate) => {
    if (!candidate.identifier) {
      return context.invalidExtraction_('Missing identifier.', 'Find it.', {
        code: 'invoice_identifier_missing', fields: ['identifier'], repairable: true
      });
    }
    if (candidate.total === 99) {
      return context.invalidExtraction_('Mismatch.', 'Reconcile it.', {
        code: 'monetary_reconciliation_mismatch', fields: ['total'], repairable: true
      });
    }
    return { valid: true, stage: 'target-spreadsheet' };
  };
  context.logCatalogEvent_ = () => {};

  const result = context.extractUtilityDataWithRepair_(
    { getId: () => 'file-id' }, 'policy'
  );
  assert.equal(result.validation.valid, true);
  assert.equal(repairContexts[2].feedback.issues[0].code,
    'monetary_reconciliation_mismatch');
  assert.deepEqual(JSON.parse(JSON.stringify(
    repairContexts[2].history.map((entry) => entry.code)
  )), ['invoice_identifier_missing', 'monetary_reconciliation_mismatch']);
  assert.equal(repairContexts[2].previousExtraction.total, 99);
  assert.equal(context.buildExtractionRepairPromptLines_(repairContexts[2])
    .join('\n').includes('persisted across'), false);
}

function testModelNormalizationFailureIsRepairable() {
  const context = loadCataloger();
  assert.equal(context.isModelExtractionNormalizationError_(new Error(
    'Gemini extraction has a nonnumeric electricity band consumption value.'
  )), true);
  assert.equal(context.isModelExtractionNormalizationError_(new Error(
    'Configured sheet was not found: Electricity'
  )), false);
}

function testExtractionValidationPipelineStopsAtTheFailingBoundary() {
  const context = loadCataloger();
  const calls = [];
  context.validateExtraction_ = () => {
    calls.push('extraction');
    return { valid: true };
  };
  context.validateServiceIdentityForInvoice_ = () => {
    calls.push('identity');
    return context.invalidExtraction_(
      'Identity mismatch.', 'Recheck identity.',
      {
        code: 'service_identity_mismatch',
        fields: ['account_holder'],
        repairable: true
      }
    );
  };
  context.validateTargetSheetValues_ = () => {
    calls.push('target');
    return { valid: true };
  };

  const invoice = { ...validInvoice(), address_type: 'unknown' };
  const result = context.validateExtractedUtilityDataForImport_(invoice);

  assert.equal(result.valid, false);
  assert.equal(result.stage, 'service-identity');
  assert.deepEqual(calls, ['extraction', 'identity']);
  assert.equal(invoice.address_type, 'unknown');
}

function testExhaustedExtractionRepairDoesNotStartMutations() {
  const context = loadCataloger();
  const mutationCalls = [];
  const extracted = { ...validInvoice(), identifier: '' };
  context.sha256ForFile_ = () => 'hash';
  context.extractUtilityDataWithRepair_ = () => ({
    extracted,
    validation: {
      valid: false,
      stage: 'extraction',
      code: 'invoice_identifier_missing',
      problem: 'Invoice identifier is missing.',
      action: 'Verify the invoice number.',
      repairable: true
    },
    aiCallCount: 3,
    repairAttemptCount: 2
  });
  context.findDuplicate_ = () => {
    mutationCalls.push('duplicate');
    return { status: 'none' };
  };
  context.saveMutationJournal_ = () => mutationCalls.push('journal');
  context.getDestinationFolder_ = () => {
    mutationCalls.push('destination');
    return {};
  };

  const result = context.processIntakeFile_({
    getId: () => 'file-id',
    getName: () => 'invoice.pdf',
    getSize: () => 100,
    getUrl: () => 'https://drive.test/file-id'
  }, {}, 'policy');

  assert.equal(result.status, 'NEEDS REVIEW');
  assert.equal(result.problem, 'Invoice identifier is missing.');
  assert.deepEqual(mutationCalls, []);
}

function testExtractionRepairPromptRequiresCompleteReplacementWithMemory() {
  const context = loadCataloger();
  context.getLocalization_ = () => ({ promptLanguage: 'English' });
  context.getAutomationConfig_ = () => ({
    address_rules: [],
    frequency_overrides: [],
    canonical_suppliers: ['SUPPLIER'],
    canonical_supplies: ['Water'],
    supply_aliases: {},
    supplier_aliases: {}
  });
  const prompt = context.buildExtractionPrompt_({ Water: [] }, 'policy', {
    attempt: 3,
    previousExtraction: { identifier: null, supplier: 'SUPPLIER' },
    feedback: {
      version: 1,
      failed_attempt: 2,
      max_ai_calls: 3,
      issues: [{
        stage: 'extraction',
        code: 'invoice_identifier_missing',
        fields: ['identifier'],
        problem: 'Invoice identifier is missing.',
        requested_action: 'Verify the invoice number.'
      }]
    },
    history: [
      { attempt: 1, stage: 'extraction', code: 'invoice_identifier_missing' },
      { attempt: 2, stage: 'extraction', code: 'invoice_identifier_missing' }
    ]
  });

  assert.match(prompt, /attempt 3 of 3/);
  assert.match(prompt, /Structured deterministic validator feedback/);
  assert.match(prompt, /Prior repair history/);
  assert.match(prompt, /Keep previously extracted fields unchanged/);
  assert.match(prompt, /Return the complete JSON object/);
  assert.match(prompt, /Do not return a partial patch/);
  assert.match(prompt, /may not decide whether the document is importable/);
  assert.match(prompt, /invoice_identifier_missing/);
  assert.match(prompt, /Inspect alternative labels, tables, summaries/);
}

function testAmbiguousAddressRulesFailClosed() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({
    address_rules: [
      { match: 'CENTRAL AVENUE', type: 'import' },
      { match: 'OFFICE CENTRAL AVENUE', type: 'archive_only' }
    ]
  });

  assert.equal(
    context.classifyAddress_('Office Central Avenue 1'),
    'unknown'
  );
}

function testHiddenPdfsAreExcludedFromIntake() {
  const context = loadCataloger();
  const rootFolder = { getId: () => 'root-folder-id' };
  const makeFile = (name) => ({
    getMimeType: () => 'application/pdf',
    isTrashed: () => false,
    getName: () => name,
    getParents: () => {
      let available = true;
      return {
        hasNext: () => available,
        next: () => {
          available = false;
          return rootFolder;
        }
      };
    }
  });

  assert.equal(
    context.isDirectIntakePdf_(makeFile('.hidden.pdf'), rootFolder),
    false
  );
  assert.equal(
    context.isDirectIntakePdf_(makeFile('visible.pdf'), rootFolder),
    true
  );
}

function testDeveloperApiKeyUsesHeader() {
  const requests = [];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: (url, options) => {
        requests.push({ url, options });
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [{
              finishReason: 'STOP',
              content: { parts: [{ text: '{}' }] }
            }]
          })
        };
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-3.7-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logCatalogEvent_ = () => {};
  context.logGeminiUsage_ = () => {};
  const file = { getId: () => 'file-id' };
  const blob = { getBytes: () => [1, 2, 3] };

  context.callGeminiForPdfWithBackend_(
    blob,
    [],
    'policy',
    file,
    'gemini_api',
    ''
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.includes('?key='), false);
  assert.equal(requests[0].options.headers['x-goog-api-key'], 'developer-secret');
  const payload = JSON.parse(requests[0].options.payload);
  assert.equal(
    payload.generationConfig.maxOutputTokens,
    vm.runInContext('CONFIG.GEMINI_MAX_OUTPUT_TOKENS', context)
  );
  assert.equal(
    payload.generationConfig.thinkingConfig.thinkingLevel,
    vm.runInContext('CONFIG.GEMINI_FLASH_THINKING_LEVEL', context)
  );
  assert.equal(payload.generationConfig.responseMimeType, 'application/json');
  assert.equal(payload.generationConfig.responseJsonSchema.type, 'object');
  assert.deepEqual(
    payload.generationConfig.responseJsonSchema.required,
    [
      'document_type',
      'supplier',
      'supply_type',
      'address_type',
      'address_evidence',
      'account_holder',
      'service_street',
      'service_civic_number',
      'service_city',
      'service_postal_code',
      'issue_date',
      'identifier',
      'contract_number',
      'customer_code',
      'contract_object',
      'reference_year',
      'reference_month',
      'frequency',
      'frequency_source_evidence',
      'period_start',
      'period_end',
      'consumption_description',
      'cost_consumption',
      'cost_non_consumption',
      'vat',
      'total',
      'sheet_values',
      'problems'
    ]
  );
  assert.deepEqual(
    payload.generationConfig.responseJsonSchema.properties.document_type.enum,
    ['Invoice', 'Contract', 'Report', 'unknown']
  );
  assert.deepEqual(
    payload.generationConfig.responseJsonSchema.properties.sheet_values
      .items.properties.value.type,
    ['string', 'number', 'boolean', 'null']
  );
  assert.deepEqual(
    payload.generationConfig.responseJsonSchema.properties.sheet_values
      .items.properties.source_evidence.enum,
    ['printed']
  );
}

function testConfigureGeminiModelUpdatesTheSharedRuntimeModel() {
  const properties = {};
  const context = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] || '',
        setProperty: (key, value) => {
          properties[key] = value;
        }
      })
    }
  });
  context.getSetupStatus = () => ({ geminiModel: context.getGeminiModel_() });

  assert.equal(context.getGeminiModel_(), 'gemini-3.7-flash');
  properties.GEMINI_MODEL = 'gemini-3.6-flash';
  assert.equal(context.getGeminiModel_(), 'gemini-3.7-flash');

  const result = context.configureGeminiModel('gemini-3.6-flash');

  assert.equal(properties.GEMINI_MODEL, 'gemini-3.7-flash');
  assert.equal(result.geminiModel, 'gemini-3.7-flash');
  assert.throws(
    () => context.configureGeminiModel('models/gemini-3.7-flash'),
    /must be a Gemini model identifier/
  );
}

function testVertexCostEstimateDoesNotReusePricingForGemini37() {
  const context = loadCataloger();
  const usage = {
    promptTokenCount: 1000000,
    candidatesTokenCount: 1000000,
    thoughtsTokenCount: 0
  };

  assert.equal(
    context.estimateGeminiUsageCostUsd_('vertex_ai', 'gemini-3.7-flash', usage),
    null
  );
  assert.equal(
    JSON.stringify(context.estimateGeminiUsageCostUsd_(
      'vertex_ai', 'gemini-2.5-flash', usage
    )),
    JSON.stringify({
      pricingSource: 'vertex-ai-standard-list-price-2026-07',
      estimatedInputCostUsd: 0.3,
      estimatedOutputCostUsd: 2.5,
      estimatedCostUsd: 2.8
    })
  );
}

function testGemini37UsageTelemetryOmitsUnpricedEstimate() {
  const events = [];
  const context = loadCataloger();
  context.getGeminiModel_ = () => 'gemini-3.7-flash';
  context.logCatalogEvent_ = (event, details) => events.push({ event, details });
  context.logGeminiUsage_({
    promptTokenCount: 1,
    candidatesTokenCount: 2,
    thoughtsTokenCount: 3,
    totalTokenCount: 6
  }, { getId: () => 'file-id' }, 'vertex_ai', '', 1);

  const payload = events[0].details;
  assert.equal(events[0].event, 'gemini-generation-usage');
  assert.equal(payload.model, 'gemini-3.7-flash');
  assert.equal(payload.promptTokenCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'estimatedCostUsd'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(payload, 'pricingSource'), false);

  context.getGeminiModel_ = () => 'unpriced-model';
  context.logGeminiUsage_({ promptTokenCount: 1 }, { getId: () => 'file-id' },
    'vertex_ai', '', 1);
  const unknownPayload = events[1].details;
  assert.equal(Object.prototype.hasOwnProperty.call(unknownPayload, 'estimatedCostUsd'), false);
}

function testIncompleteGeminiResponseReportsFinishReason() {
  const events = [];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{
            finishReason: 'MAX_TOKENS',
            content: { parts: [{ text: '{"partial":' }] }
          }]
        })
      })
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logGeminiUsage_ = () => {};
  context.logCatalogEvent_ = (event, details) => events.push({ event, details });

  assert.throws(
    () => context.callGeminiForPdfWithBackend_(
      { getBytes: () => [1, 2, 3] },
      [],
      'policy',
      { getId: () => 'file-id' },
      'gemini_api',
      ''
    ),
    /finish reason: MAX_TOKENS/
  );
  assert.equal(
    events.find((entry) => entry.event === 'gemini-generation-response')
      .details.finishReason,
    'MAX_TOKENS'
  );
}

function testGeminiResponseWithoutFinishReasonFailsClosed() {
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: () => ({
        getResponseCode: () => 200,
        getContentText: () => JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{}' }] } }]
        })
      })
    }
  });
  context.getGeminiModel_ = () => 'gemini-3.7-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logGeminiUsage_ = () => {};
  context.logCatalogEvent_ = () => {};

  assert.throws(
    () => context.callGeminiForPdfWithBackend_(
      { getBytes: () => [1, 2, 3] },
      [],
      'policy',
      { getId: () => 'file-id' },
      'gemini_api',
      ''
    ),
    /finish reason: UNSPECIFIED/
  );
}

function testDepletedPrepaymentCreditsSwitchToVertexForOneHour() {
  const requests = [];
  const events = [];
  const properties = {
    GEMINI_API_KEY: 'developer-secret',
    GEMINI_BACKEND: 'gemini_api',
    GEMINI_AUTO_VERTEX_FALLBACK: 'true',
    GOOGLE_CLOUD_PROJECT_ID: 'cataloger-project'
  };
  const responses = [
    {
      getResponseCode: () => 429,
      getContentText: () => JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Your prepayment credits are depleted. Please go to AI Studio at ' +
            'https://ai.studio/projects to manage your project and billing. Learn more at ' +
            'https://ai.google.dev/gemini-api/docs/billing#prepay.'
        }
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    }
  ];
  const context = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] || '',
        setProperty: (key, value) => {
          properties[key] = value;
        }
      })
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        requests.push({ url, options });
        return responses.shift();
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getVertexAiLocation_ = () => 'global';
  context.getScriptProperty_ = (key) => properties[key] || '';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logGeminiUsage_ = () => {};
  context.logCatalogEvent_ = (event, details) => {
    events.push({ event, details });
  };

  const blob = { getBytes: () => [1, 2, 3] };
  const firstResult = context.callGeminiForPdf_(
    blob,
    {},
    'policy',
    { getId: () => 'first-file-id' }
  );

  assert.equal(firstResult, '{}');
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /generativelanguage\.googleapis\.com/);
  assert.match(requests[1].url, /aiplatform\.googleapis\.com/);
  assert.ok(Number(properties.GEMINI_VERTEX_FALLBACK_UNTIL) > Date.now());
  assert.equal(
    events.find((entry) => entry.event === 'gemini-vertex-fallback-activated')
      .details.reason,
    'gemini-api-prepayment-credits-depleted'
  );

  const secondResult = context.callGeminiForPdf_(
    blob,
    {},
    'policy',
    { getId: () => 'second-file-id' }
  );
  assert.equal(secondResult, '{}');
  assert.match(requests[2].url, /aiplatform\.googleapis\.com/);

  properties.GEMINI_VERTEX_FALLBACK_UNTIL = String(Date.now() - 1);
  const thirdResult = context.callGeminiForPdf_(
    blob,
    {},
    'policy',
    { getId: () => 'third-file-id' }
  );
  assert.equal(thirdResult, '{}');
  assert.match(requests[3].url, /generativelanguage\.googleapis\.com/);
}

function testRepairContextSurvivesAutomaticVertexFallback() {
  const requests = [];
  const events = [];
  const usageAttempts = [];
  const responses = [
    {
      getResponseCode: () => 429,
      getContentText: () => JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Daily quota exhausted.'
        }
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }],
        usageMetadata: { promptTokenCount: 1 }
      })
    }
  ];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: (url, options) => {
        requests.push({ url, payload: JSON.parse(options.payload) });
        return responses.shift();
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getVertexAiLocation_ = () => 'global';
  context.getScriptProperty_ = (key) => key === 'GEMINI_API_KEY' ?
    'developer-secret' : 'cataloger-project';
  context.isAutomaticVertexFallbackEnabled_ = () => true;
  context.classifyGeminiApiAvailabilityLimit_ = () => 'daily-quota-exhausted';
  context.activateTemporaryVertexFallback_ = () => {};
  context.buildExtractionPrompt_ = (_headers, _policy, repairContext) =>
    'repair-attempt:' + repairContext.attempt;
  context.logCatalogEvent_ = (event, details) => events.push({ event, details });
  context.logGeminiUsage_ = (_usage, _file, _backend, _reason,
    extractionAttempt) => usageAttempts.push(extractionAttempt);
  const repairContext = {
    attempt: 2,
    previousExtraction: { identifier: '' },
    feedback: { issues: [{ code: 'invoice_identifier_missing' }] },
    history: []
  };

  assert.equal(context.callGeminiForPdfWithBackend_(
    { getBytes: () => [1, 2, 3] }, {}, 'policy',
    { getId: () => 'file-id' }, 'gemini_api', '', repairContext
  ), '{}');
  assert.equal(requests.length, 2);
  requests.forEach((request) => {
    assert.equal(request.payload.contents[0].parts[0].text,
      'repair-attempt:2');
  });
  assert.equal(events.filter((entry) =>
    ['gemini-generation-request', 'gemini-generation-response']
      .includes(entry.event)).every((entry) =>
    entry.details.extractionAttempt === 2), true);
  assert.deepEqual(usageAttempts, [2]);
  assert.equal(JSON.stringify(events).includes('invoice_identifier_missing'), false);
}

function testEmailReportIncludesSoftwareVersion() {
  const context = loadCataloger();
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/en.gs'), 'utf8'),
    context,
    { filename: 'locales/en.gs' }
  );
  context.getLocalization_ = () => context.getEnglishLocalization_();

  const report = context.formatResult_({
    status: 'ERROR',
    originalName: 'invoice.pdf',
    assignedName: '',
    fileUrl: 'https://drive.test/file-id',
    destination: '',
    supplySupplier: '',
    extracted: {},
    actions: 'No changes.',
    problem: 'Provider unavailable.',
    recommendedAction: 'Retry later.'
  });

  assert.equal(
    report.startsWith(
      'Software version: ' + context.getApplicationVersion() + '\nSTATUS: ERROR\n'
    ),
    true
  );
  assert.match(report, /Failure stage: not available/);
  assert.match(report, /Persistence: not available/);

  const linkedReport = context.formatResult_(Object.assign({}, {
    status: 'ERROR', originalName: 'invoice.pdf', fileUrl: 'https://drive.test/file-id',
    extracted: {}, actions: 'No changes.', problem: 'Provider unavailable.',
    recommendedAction: 'Retry later.', supplierProfilesUrl: 'https://drive.test/profiles',
    retryUrl: 'https://script.google.com/home/projects/script-id/edit?function=retryFailedUtilitiesCataloging'
  }));
  assert.match(linkedReport, /Supplier profiles and proposals: https:\/\/drive\.test\/profiles/);
  assert.match(linkedReport, /Retry import: https:\/\/script\.google\.com\/home\/projects\/script-id/);
}

function testPostExtractionSpreadsheetErrorReportPreservesDiagnostics() {
  const cloudPayloads = [];
  const consoleErrors = [];
  const extraction = validInvoice();
  extraction.contract_number = 'CONTRACT-RECOVERY';
  extraction.customer_code = 'CUSTOMER-RECOVERY';
  extraction.frequency = 'monthly';
  extraction.sheet_values = [
    { header: 'Consumption quantity F1', value: 368.74 },
    { header: 'Unit cost F1', value: 0.12 }
  ];
  const file = {
    getId: () => 'file-id',
    getName: () => 'invoice.pdf',
    getSize: () => 10,
    getUrl: () => 'https://drive.test/file-id'
  };
  const context = loadCataloger({
    Logger: { log: (payload) => cloudPayloads.push(payload) },
    console: { error: (message) => consoleErrors.push(message) }
  });
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/en.gs'), 'utf8'),
    context,
    { filename: 'locales/en.gs' }
  );
  context.getLocalization_ = () => context.getEnglishLocalization_();
  context.sha256ForFile_ = () => 'hash';
  context.extractUtilityData_ = () => extraction;
  context.validateExtraction_ = () => ({ valid: true });
  context.validateServiceIdentityForInvoice_ = () => ({ valid: true });
  context.validateTargetSheetValues_ = () => ({ valid: true });
  context.findDuplicate_ = () => ({ status: 'none' });
  context.buildAssignedName_ = () => 'assigned.pdf';
  context.saveMutationJournal_ = () => {};
  context.updateMutationJournal_ = () => {};
  context.getDestinationFolder_ = () => ({ folder: {}, path: 'Water/2026' });
  context.getDestinationCollision_ = () => ({ status: 'none' });
  context.importUtilityInvoiceToSheet_ = () => {
    const error = new Error('Spreadsheet formula total verification failed for: Total cost');
    error.verificationDiscrepancies = [{
      field: 'Total cost',
      expected: 14.64,
      actual: 12.34,
      valueType: 'money',
      tolerance: 0.02
    }];
    throw error;
  };
  context.rollbackProcessingMutations_ = (_file, _root, _name, state) => {
    state.rollbackErrors = [];
  };
  context.describeError_ = (error) => error.message;
  context.classifyCatalogErrorForLog_ = () => 'spreadsheet';
  context.attachMutationJournal_ = (result) => result;

  const result = context.processIntakeFile_(file, {}, 'policy');
  const report = context.formatResult_(result);

  assert.equal(result.status, 'ERROR');
  assert.deepEqual(JSON.parse(JSON.stringify(result.extracted)), extraction);
  assert.equal(result.supplySupplier, 'Water / SUPPLIER');
  assert.equal(result.failureStage, 'spreadsheet-write-and-verify');
  assert.equal(result.extractionValidated, true);
  assert.match(report, /Failure stage: Writing and verifying spreadsheet row/);
  assert.match(report, /Gemini extracted data: available, not imported/);
  assert.ok(report.includes('Extracted snapshot: ' + JSON.stringify(extraction)));
  assert.match(report, /Persistence: no import persisted; rollback completed/);
  assert.match(report, /Supply \/ supplier: Water \/ SUPPLIER/);
  assert.match(report, /Total: 14\.64 EUR/);
  assert.match(report, /Reconciliation check: passed: 14\.64 EUR \/ 14\.64 EUR/);
  assert.match(report,
    /Detected discrepancy: field Total cost; expected 14\.64 EUR; observed 12\.34 EUR; tolerance 0\.02 EUR/);
  assert.deepEqual(JSON.parse(JSON.stringify(cloudPayloads)), [
    {
      message: 'extraction-validation-completed',
      component: 'drive-utilities-cataloger',
      applicationVersion: '0.5.0',
      event: 'extraction-validation-completed',
      fileId: 'file-id',
      extractionAttempt: 1,
      valid: true,
      stage: 'target-spreadsheet',
      issueCode: ''
    },
    {
      message: 'catalog-file-processing-error',
      component: 'drive-utilities-cataloger',
      applicationVersion: '0.5.0',
      event: 'catalog-file-processing-error',
      fileId: 'file-id',
      errorType: 'Error',
      errorCategory: 'spreadsheet',
      failureStage: 'spreadsheet-write-and-verify'
    }
  ]);
  assert.deepEqual(consoleErrors, [
    'Catalog file processing failed for file ID file-id (spreadsheet).'
  ]);
  const cloudText = JSON.stringify({ cloudPayloads, consoleErrors });
  [
    extraction.supplier,
    extraction.identifier,
    extraction.period_start,
    String(extraction.total),
    '12.34',
    'Spreadsheet formula total verification failed for: Total cost'
  ].forEach((sensitiveValue) => {
    assert.equal(cloudText.includes(sensitiveValue), false);
  });

  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/it.gs'), 'utf8'),
    context,
    { filename: 'locales/it.gs' }
  );
  context.getLocalization_ = () => context.getItalianLocalization_();
  const italianReport = context.formatResult_(result);
  assert.match(italianReport, /Fase errore: Scrittura e verifica riga del foglio/);
  assert.match(italianReport, /Dati estratti da Gemini: disponibili, non importati/);
  assert.ok(italianReport.includes('Snapshot estrazione: ' +
    JSON.stringify(extraction)));
  assert.match(italianReport,
    /Stato importazione: nessun import persistito; rollback completato/);
  assert.match(italianReport,
    /Verifica quadratura: superata: 14\.64 EUR \/ 14\.64 EUR/);
  assert.match(italianReport,
    /Discrepanza rilevata: campo Total cost; atteso 14\.64 EUR; riscontrato 12\.34 EUR; tolleranza 0\.02 EUR/);

  context.rollbackProcessingMutations_ = (_file, _root, _name, state) => {
    state.rollbackErrors = ['Spreadsheet rollback failed: service unavailable'];
  };
  const incompleteRollbackResult = context.processIntakeFile_(file, {}, 'policy');
  assert.equal(incompleteRollbackResult.rollbackCompleted, false);
  assert.equal(incompleteRollbackResult.keepMutationJournal, true);
  assert.match(context.formatResult_(incompleteRollbackResult),
    /Stato importazione: rollback incompleto; verifica manuale necessaria/);
}

function testFailedFirstImportRestoresServiceIdentityControls() {
  const context = loadCataloger();
  const cells = {
    holder: 'Avery North',
    address: 'Cedar Meridian Boulevard 125 99991 Rivermouth'
  };
  const sheet = {
    getName: () => 'Water',
    getRange: (_row, column) => ({
      setRichTextValue: (value) => {
        if (column === 5) {
          cells.holder = value.text;
        } else if (column === 6) {
          cells.address = value.text;
        }
      }
    })
  };
  const bootstrap = {
    sheet,
    metadataRow: 1,
    holderColumn: 5,
    addressColumn: 6,
    previousAccountHolder: 'Enter account holder here',
    previousServiceAddress: 'Enter service address here',
    started: true,
    completed: true
  };
  const file = {
    getId: () => 'file-id',
    getName: () => 'invoice.pdf',
    getSize: () => 100,
    getUrl: () => 'https://drive.test/file-id',
    setName: () => { throw new Error('Drive rename failed'); }
  };
  context.sha256ForFile_ = () => 'hash';
  context.extractUtilityDataWithRepair_ = () => ({
    extracted: validInvoice(),
    validation: { valid: true, stage: 'target-spreadsheet' }
  });
  context.findDuplicate_ = () => ({ status: 'none' });
  context.buildAssignedName_ = () => 'assigned.pdf';
  context.saveMutationJournal_ = () => {};
  context.updateMutationJournal_ = () => {};
  context.getDestinationFolder_ = () => ({ folder: {}, path: 'Water/2026' });
  context.getDestinationCollision_ = () => ({ status: 'none' });
  context.importUtilityInvoiceToSheet_ = () => ({
    link: 'https://sheets.test',
    sheet,
    row: 3,
    created: true,
    serviceIdentityBootstrap: bootstrap
  });
  context.rollbackImportedRow_ = () => {};
  context.refreshElectricityDashboardAfterRollback_ = () => {};
  context.logCatalogEvent_ = () => {};
  context.classifyCatalogErrorForLog_ = () => 'drive';

  const result = context.processIntakeFile_(file, {}, 'policy');

  assert.equal(result.status, 'ERROR');
  assert.equal(cells.holder, 'Enter account holder here');
  assert.equal(cells.address, 'Enter service address here');
}

function testPreExtractionErrorReportKeepsDataUnavailable() {
  const file = {
    getId: () => 'file-id',
    getName: () => 'invoice.pdf',
    getSize: () => 10,
    getUrl: () => 'https://drive.test/file-id'
  };
  const context = loadCataloger({ Logger: { log: () => {} } });
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/en.gs'), 'utf8'),
    context,
    { filename: 'locales/en.gs' }
  );
  context.getLocalization_ = () => context.getEnglishLocalization_();
  context.sha256ForFile_ = () => {
    throw new Error('Gemini network error');
  };
  context.attachMutationJournal_ = (result) => result;

  const result = context.processIntakeFile_(file, {}, 'policy');
  const report = context.formatResult_(result);

  assert.equal(result.status, 'ERROR');
  assert.deepEqual(JSON.parse(JSON.stringify(result.extracted)), {});
  assert.equal(result.extractionValidated, false);
  assert.equal(result.failureStage, 'extracting-document-data');
  assert.match(report, /Gemini extracted data: not available/);
  assert.match(report, /Reconciliation check: not applicable/);
}

function testErrorResultMarksRetainedDestinationFoldersAsIncomplete() {
  const context = loadCataloger();
  const file = {
    getName: () => 'invoice.pdf',
    getUrl: () => 'https://drive.test/file-id'
  };

  const result = context.buildErrorResult_(
    file,
    'Drive destination creation failed.',
    'Inspect the intake folder before retrying.',
    'invoice.pdf',
    { createdFolderPath: 'Water/2026', rollbackErrors: [] }
  );

  assert.equal(result.rollbackCompleted, false);
  assert.match(result.actions, /Automatic rollback was incomplete/);
  assert.match(result.actions, /empty destination folders may remain at Water\/2026/);
  assert.doesNotMatch(result.actions, /Any partial Drive or spreadsheet mutation was rolled back/);
}

function testDestinationFolderCreationCheckpointsEachCreatedPath() {
  const context = loadCataloger();
  const fileId = 'destination-checkpoint-file-id';
  const { store } = installScriptPropertyStore(context);
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX', context
  ) + fileId;
  const file = {
    getId: () => fileId,
    getName: () => 'invoice.pdf',
    getSize: () => 10,
    getUrl: () => 'https://drive.test/destination-checkpoint-file-id'
  };
  const failingChild = {
    getFoldersByName: () => {
      const journal = JSON.parse(store[journalKey]);
      assert.equal(journal.createdFolderPath, 'Water');
      assert.equal(journal.failureStage, 'preparing-drive-destination');
      throw new Error('second destination folder lookup failed');
    }
  };
  const rootFolder = {
    getFoldersByName: () => driveIterator([]),
    createFolder: (name) => {
      assert.equal(name, 'Water');
      return failingChild;
    }
  };
  context.getAutomationConfig_ = () => ({
    destination_templates: {},
    canonical_suppliers: []
  });
  context.sha256ForFile_ = () => 'hash';
  context.extractUtilityData_ = () => validInvoice();
  context.validateExtraction_ = () => ({ valid: true });
  context.validateServiceIdentityForInvoice_ = () => ({ valid: true });
  context.validateTargetSheetValues_ = () => ({ valid: true });
  context.findDuplicate_ = () => ({ status: 'none' });
  context.buildAssignedName_ = () => 'assigned.pdf';
  context.rollbackProcessingMutations_ = (_file, _root, _name, state) => {
    state.rollbackErrors = [];
  };
  context.describeError_ = (error) => error.message;
  context.classifyCatalogErrorForLog_ = () => 'drive';
  context.logCatalogEvent_ = () => {};

  const result = context.processIntakeFile_(file, rootFolder, 'policy');

  assert.equal(result.rollbackCompleted, false);
  assert.match(result.actions, /empty destination folders may remain at Water/);
  assert.equal(JSON.parse(store[journalKey]).createdFolderPath, 'Water');
}

function testGenericRateLimitStaysOnDeveloperApi() {
  const requests = [];
  const responses = [
    {
      getResponseCode: () => 429,
      getContentText: () => JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Requests per minute limit exceeded. Retry in 1 second. ' +
            'Learn more at https://ai.google.dev/gemini-api/docs/billing#prepay.'
        }
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    }
  ];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: (url) => {
        requests.push(url);
        return responses.shift();
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getScriptProperty_ = () => 'developer-secret';
  context.isAutomaticVertexFallbackEnabled_ = () => true;
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logCatalogEvent_ = () => {};
  context.logGeminiUsage_ = () => {};

  context.callGeminiForPdfWithBackend_(
    { getBytes: () => [1, 2, 3] },
    {},
    'policy',
    { getId: () => 'file-id' },
    'gemini_api',
    ''
  );

  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((url) => url.includes('generativelanguage.googleapis.com')),
    true
  );
}

function testVertexRateLimitRetriesWithoutReclassifyingProviderQuota() {
  const requests = [];
  const responses = [
    {
      getResponseCode: () => 429,
      getContentText: () => JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'GenerateRequestsPerDay quota exceeded temporarily.'
        }
      })
    },
    {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({
        candidates: [{
          finishReason: 'STOP',
          content: { parts: [{ text: '{}' }] }
        }]
      })
    }
  ];
  const context = loadCataloger({
    UrlFetchApp: {
      fetch: (url) => {
        requests.push(url);
        return responses.shift();
      }
    }
  });
  context.getGeminiModel_ = () => 'gemini-2.5-flash';
  context.getVertexAiLocation_ = () => 'global';
  context.getScriptProperty_ = () => 'cataloger-project';
  context.buildExtractionPrompt_ = () => 'prompt';
  context.logCatalogEvent_ = () => {};
  context.logGeminiUsage_ = () => {};

  context.callGeminiForPdfWithBackend_(
    { getBytes: () => [1, 2, 3] },
    {},
    'policy',
    { getId: () => 'file-id' },
    'vertex_ai',
    'gemini-api-daily-quota-exhausted'
  );

  assert.equal(requests.length, 2);
  assert.equal(
    requests.every((url) => url.includes('aiplatform.googleapis.com')),
    true
  );
}

function testStructuredFileLogsContainOnlyOpaqueId() {
  const logPayloads = [];
  const context = loadCataloger({
    Logger: {
      log: (payload) => logPayloads.push(payload)
    }
  });
  const details = context.describeFileForLog_({
    getId: () => 'opaque-file-id',
    getName: () => 'private-invoice-name.pdf'
  });

  assert.deepEqual(
    JSON.parse(JSON.stringify(details)),
    { fileId: 'opaque-file-id' }
  );
  assert.equal(
    context.classifyCatalogErrorForLog_(
      new Error('Spreadsheet row contained private values')
    ),
    'spreadsheet'
  );
  context.logCatalogEvent_('test-event', details);
  assert.equal(
    logPayloads[0].applicationVersion,
    context.getApplicationVersion()
  );
}

function testReportFieldsCannotInjectExtraLines() {
  const context = loadCataloger();

  assert.equal(
    context.oneLineReportText_(
      'invoice.pdf\nSTATUS: IMPORTED\r\nIssue: fake'
    ),
    'invoice.pdf STATUS: IMPORTED Issue: fake'
  );
}

function testDashboardRefreshWarningIsReported() {
  const context = loadCataloger();
  context.getAutomationConfig_ = () => ({ locale: 'en' });
  const dashboardResult = context.buildSuccessResult_(
    { getUrl: () => 'https://drive.example/file' }, 'invoice.pdf',
    'archived.pdf', { path: 'Water/SUPPLIER/2026', createdFolders: [] },
    { ...validInvoice() }, 'https://sheets.example/spreadsheet',
    'Electricity dashboard refresh failed; imported invoice data was retained.'
  );
  assert.equal(dashboardResult.status, 'IMPORTED WITH WARNINGS');
  assert.deepEqual(JSON.parse(JSON.stringify(dashboardResult.warnings)), [{
    field: 'electricity dashboard',
    reason: 'Electricity dashboard refresh failed; imported invoice data was retained.'
  }]);
}

function testPromptKeepsHeadersScopedBySupply() {
  const context = loadCataloger();
  context.getLocalization_ = () => ({ promptLanguage: 'English' });
  context.getAutomationConfig_ = () => ({
    address_rules: [],
    address_missing_type: 'import',
    frequency_overrides: [],
    canonical_suppliers: ['SUPPLIER'],
    canonical_supplies: ['Water', 'Gas'],
    supply_aliases: {},
    supplier_aliases: {}
  });
  const prompt = context.buildExtractionPrompt_({
    Water: ['Issue date', 'Cubic metres'],
    Gas: ['Issue date', 'Standard cubic metres']
  }, 'trusted policy');

  assert.match(prompt, /matching canonical supply entry/);
  assert.match(prompt, /"contract_number": "printed contract number or null"/);
  assert.match(prompt,
    /"customer_code": "printed customer\/client\/account code \(ID UTENTE is a customer code\), or null"/);
  assert.match(prompt, /Never substitute one for the other/);
  assert.match(prompt, /one of contract_number or customer_code is sufficient/);
  assert.match(prompt, /Preserve every character and leading zero/);
  assert.match(prompt, /two-character text value in the exact format mm/);
  assert.match(prompt, /measurements, and reference year\./);
  assert.doesNotMatch(prompt, /reference year\/month/);
  assert.match(prompt, /Do not add a problem merely to note that line items include VAT/);
  assert.match(prompt, /mutually exclusive top-level printed cost row/);
  assert.match(prompt, /If one target header represents a combined category, sum only the mutually exclusive top-level rows/);
  assert.match(prompt, /same printed parent section/);
  assert.match(prompt, /subordinate lines introduced by "di cui"/);
  assert.match(prompt, /For every non-formula header exposed by the matching target sheet/);
  assert.match(prompt,
    /If a configured secondary field is explicitly absent or not applicable/);
  assert.match(prompt, /only after core monetary reconciliation succeeds/);
  assert.match(prompt, /Unreadable, ambiguous, inconsistent, or mismatched evidence remains blocking/);
  assert.match(prompt, /If cadence cannot be established or conflicts, the diagnostic blocks import/);
  assert.doesNotMatch(prompt, /runtime may import the invoice with that field blank/);
  assert.match(prompt,
    /Prior imported invoices may be used only as corroborating evidence for stable classifications or derived cadence/);
  assert.match(prompt,
    /never copy a transaction-specific value from another invoice into this one/);
  assert.match(prompt, /source_evidence "printed"/);
  assert.doesNotMatch(prompt,
    /If a field is genuinely not printed or not applicable, leave it absent and add a concise problem/);
  assert.match(prompt, /recurring Iliad Internet charges/);
  assert.match(prompt, /localized supplier field defaults/);
  assert.match(prompt, /numeric value 0/);
  assert.match(prompt, /Infer each table role from its headings and units, not its title/);
  assert.match(prompt, /Energy-mix, offer, marketing, and explanatory tables are not required/);
  assert.match(prompt, /documented invoice\/report structure as corroborating classification evidence/);
  assert.match(prompt, /"Water":\["Issue date","Cubic metres"\]/);
  assert.match(prompt, /"Gas":\["Issue date","Standard cubic metres"\]/);
}

function testHeadersAreCollectedPerSupply() {
  const context = loadCataloger();
  const sheets = {
    Water: {
      name: 'Water',
      headers: ['Issue date', 'Cubic metres'],
      getLastRow: () => 1
    },
    Gas: {
      name: 'Gas',
      headers: ['Issue date', 'Standard cubic metres'],
      getLastRow: () => 1
    }
  };
  context.getAutomationConfig_ = () => ({
    canonical_supplies: ['Water', 'Gas'],
    sheet_by_supply: { Water: 'Water', Gas: 'Gas' }
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: (name) => sheets[name]
  });
  context.getSheetLayout_ = (sheet) => ({
    headerRow: 1,
    headers: sheet.headers,
    lookup: {}
  });

  assert.equal(
    JSON.stringify(context.getSheetHeadersBySupply_()),
    JSON.stringify({
      Water: ['Issue date', 'Cubic metres'],
      Gas: ['Issue date', 'Standard cubic metres']
    })
  );
}

function testDuplicateNormalizedSheetHeadersAreRejected() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['Issue date'],
    supplier: ['Supplier']
  })[key] || [];
  const sheet = {
    getLastColumn: () => 3,
    getLastRow: () => 1,
    getName: () => 'Water',
    getRange: () => ({
      getDisplayValues: () => [[
        'Issue date',
        'Supplier',
        'Supplier!'
      ]]
    })
  };

  assert.throws(
    () => context.getSheetLayout_(sheet),
    /Duplicate normalized spreadsheet headers/
  );
}

function testSheetLayoutAcceptsPendingLocaleAliases() {
  const context = loadCataloger();
  context.getHeaderAliases_ = () => {
    throw new Error('persisted automation configuration is unavailable');
  };
  const sheet = {
    getLastColumn: () => 2,
    getLastRow: () => 1,
    getName: () => 'Luce',
    getRange: () => ({
      getDisplayValues: () => [[
        'Data di emissione',
        'Fornitore'
      ]]
    })
  };

  const layout = context.getSheetLayout_(sheet, {
    issueDate: ['data di emissione'],
    supplier: ['fornitore']
  });

  assert.equal(layout.headerRow, 1);
  assert.equal(layout.lookup['data di emissione'], 1);
  assert.equal(layout.lookup.fornitore, 2);
}

function testSheetLayoutAcceptsInstallerControlRowShiftAtBoundary() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['Issue date'],
    supplier: ['Supplier']
  })[key] || [];
  const rows = Array.from({ length: 11 }, () => ['', '']);
  rows[9] = ['Controllo fornitura', 'Water'];
  rows[10] = ['Issue date', 'Supplier'];
  const sheet = {
    getLastColumn: () => 2,
    getLastRow: () => 11,
    getName: () => 'Water',
    getRange: (row, column, numberOfRows, numberOfColumns) => {
      assert.equal(row, 1);
      assert.equal(column, 1);
      assert.equal(numberOfRows, 11);
      assert.equal(numberOfColumns, 2);
      return { getDisplayValues: () => rows };
    }
  };

  const layout = context.getSheetLayout_(sheet);

  assert.equal(layout.headerRow, 11);
  assert.equal(layout.lookup['issue date'], 1);
  assert.equal(layout.lookup.supplier, 2);
}

function testSheetLayoutAcceptsHeaderAtRowTen() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['Issue date'],
    supplier: ['Supplier']
  })[key] || [];
  const rows = Array.from({ length: 10 }, () => ['', '']);
  rows[9] = ['Issue date', 'Supplier'];
  const sheet = {
    getLastColumn: () => 2,
    getLastRow: () => 10,
    getName: () => 'Water',
    getRange: (row, column, numberOfRows, numberOfColumns) => {
      assert.equal(row, 1);
      assert.equal(column, 1);
      assert.equal(numberOfRows, 10);
      assert.equal(numberOfColumns, 2);
      return { getDisplayValues: () => rows };
    }
  };

  const layout = context.getSheetLayout_(sheet);

  assert.equal(layout.headerRow, 10);
  assert.equal(layout.lookup['issue date'], 1);
  assert.equal(layout.lookup.supplier, 2);
}

function testMutationRecoveryStages() {
  function scenario(journal, markedRows) {
    const deletedRows = [];
    const refreshedRows = [];
    const dashboardRefreshes = [];
    const context = loadCataloger();
    const file = { getId: () => 'source-file-id' };
    const sheet = {
      getLastRow: () => 4,
      getRange: (row) => ({ marked: markedRows.includes(row) }),
      deleteRow: (row) => deletedRows.push(row)
    };
    context.SpreadsheetApp.openById = () => ({
      getSheetByName: () => sheet
    });
    context.getSpreadsheetId_ = () => 'spreadsheet-id';
    context.getSheetLayout_ = () => ({
      headerRow: 1,
      headers: ['Source file'],
      lookup: { 'source file': 1 }
    });
    context.getHeaderAliases_ = () => ['Source file'];
    context.findHeaderIndex_ = () => 1;
    context.getFileFromSourceCell_ = (cell) => cell.marked ? file : null;
    context.refreshImportedSourceLink_ = (_sheet, row) => {
      refreshedRows.push(row);
    };
    context.refreshElectricityDashboardAfterRollback_ = (state) => {
      dashboardRefreshes.push(state.sheet);
    };
    context.updateMutationJournal_ = () => {};
    return {
      deletedRows,
      refreshedRows,
      dashboardRefreshes,
      result: () => context.rollbackJournalSheetRow_(journal, file)
    };
  }

  const beforeMarker = scenario({
    stage: 'sheet-insert-planned',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: false
  }, []);
  assert.equal(beforeMarker.result().unmarkedRowMayRemain, true);
  assert.deepEqual(beforeMarker.deletedRows, []);

  const markerWrittenBeforeJournal = scenario({
    stage: 'sheet-insert-planned',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: false
  }, [2]);
  assert.equal(markerWrittenBeforeJournal.result().unmarkedRowMayRemain, false);
  assert.deepEqual(markerWrittenBeforeJournal.deletedRows, [2]);
  assert.equal(markerWrittenBeforeJournal.dashboardRefreshes.length, 1);

  const markerLostAfterJournal = scenario({
    stage: 'sheet-marker-written',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: true
  }, []);
  assert.throws(markerLostAfterJournal.result, /source marker is missing/);

  const deletedRowAwaitingDashboardRefresh = scenario({
    stage: 'sheet-row-rolled-back',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: false,
    sheetRowDeleted: true
  }, []);
  assert.equal(deletedRowAwaitingDashboardRefresh.result().unmarkedRowMayRemain,
    false);
  assert.equal(deletedRowAwaitingDashboardRefresh.dashboardRefreshes.length, 1);

  const existingRow = scenario({
    stage: 'sheet-existing',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: true
  }, [2]);
  assert.equal(existingRow.result().unmarkedRowMayRemain, false);
  assert.deepEqual(existingRow.deletedRows, []);
  assert.deepEqual(existingRow.refreshedRows, [2]);

  const restoredRows = [];
  const payloadFile = { getId: () => 'source-file-id' };
  const payloadContext = loadCataloger();
  payloadContext.SpreadsheetApp.openById = () => ({
    getSheetByName: () => ({
      getLastRow: () => 3,
      getRange: (row) => ({ row })
    })
  });
  payloadContext.getSpreadsheetId_ = () => 'spreadsheet-id';
  payloadContext.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Source file'],
    lookup: { 'source file': 1 }
  });
  payloadContext.getHeaderAliases_ = () => ['Source file'];
  payloadContext.findHeaderIndex_ = () => 1;
  payloadContext.getFileFromSourceCell_ = (cell) => cell.row === 3 ? payloadFile : null;
  payloadContext.restoreImportedRowPayload_ = (_sheet, row, originalRow, payload) => {
    restoredRows.push([row, originalRow, payload]);
  };
  const recoveredDashboardSheets = [];
  const rollbackLayouts = { monthlyF1: { sourceRanges: ['F1:Z13'] } };
  payloadContext.refreshElectricityDashboardAfterRollback_ = (state) => {
    recoveredDashboardSheets.push(state.sheet);
    assert.equal(JSON.stringify(state.electricityDashboardLayouts),
      JSON.stringify(rollbackLayouts));
  };
  assert.equal(payloadContext.rollbackJournalSheetRow_({
    stage: 'sheet-existing-written',
    sheetName: 'Water',
    sheetRow: 3,
    sheetOriginalRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: true,
    sheetRowPayload: { cells: [] },
    electricityDashboardLayouts: rollbackLayouts
  }, payloadFile).unmarkedRowMayRemain, false);
  assert.deepEqual(restoredRows, [[3, 2, { cells: [] }]]);
  assert.equal(recoveredDashboardSheets.length, 1);

  const existingRowAfterRename = scenario({
    stage: 'renamed',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false,
    sheetRowPreexisting: true
  }, [3]);
  assert.equal(existingRowAfterRename.result().unmarkedRowMayRemain, false);
  assert.deepEqual(existingRowAfterRename.deletedRows, []);
  assert.deepEqual(existingRowAfterRename.refreshedRows, [3]);

  const legacyExistingRowAfterRename = scenario({
    stage: 'renamed',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: false
  }, [3]);
  assert.equal(
    legacyExistingRowAfterRename.result().unmarkedRowMayRemain,
    false
  );
  assert.deepEqual(legacyExistingRowAfterRename.deletedRows, []);
  assert.deepEqual(legacyExistingRowAfterRename.refreshedRows, [3]);
}

function testMutationJournalCapturesValidatedReportingContextBeforeMutations() {
  const context = loadCataloger();
  const file = {
    getId: () => 'file-id',
    getName: () => 'invoice.pdf',
    getSize: () => 10,
    getUrl: () => 'https://drive.test/file-id'
  };
  const extraction = validInvoice();
  const propertyStore = installScriptPropertyStore(context);
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX', context
  ) + file.getId();
  context.sha256ForFile_ = () => 'hash';
  context.extractUtilityData_ = () => extraction;
  context.validateExtraction_ = () => ({ valid: true });
  context.validateServiceIdentityForInvoice_ = () => ({ valid: true });
  context.validateTargetSheetValues_ = () => ({ valid: true });
  context.findDuplicate_ = () => ({ status: 'none' });
  context.buildAssignedName_ = () => 'assigned.pdf';
  context.getDestinationFolder_ = () => {
    const journal = JSON.parse(propertyStore.store[journalKey]);
    const payloadPrefix = vm.runInContext(
      'CONFIG.PROPERTY_KEYS.MUTATION_EXTRACTION_PAYLOAD_PREFIX', context
    ) + file.getId() + '_';
    assert.equal(journal.extracted, undefined);
    assert.equal(journal.extractedChunks, 1);
    assert.deepEqual(JSON.parse(propertyStore.store[`${payloadPrefix}0`]), extraction);
    assert.equal(journal.extractionValidated, true);
    assert.equal(journal.failureStage, 'preparing-drive-destination');
    throw new Error('destination preparation interrupted');
  };
  context.describeError_ = (error) => error.message;
  context.classifyCatalogErrorForLog_ = () => 'drive';
  context.logCatalogEvent_ = () => {};

  const interrupted = context.processIntakeFile_(file, {}, 'policy');
  assert.equal(interrupted.status, 'ERROR');

  context.DriveApp = { getFileById: () => file };
  context.isFileInFolder_ = () => true;
  context.rollbackJournalSheetRow_ = () => ({ unmarkedRowMayRemain: false });
  context.recordIntakeFileOutcome_ = () => {};
  context.queuePendingReports_ = () => {};
  context.saveIntakeFileState_ = () => {};

  const recovered = context.recoverMutationJournalForFile_({}, file.getId());
  assert.deepEqual(JSON.parse(JSON.stringify(recovered.extracted)), extraction);
  assert.equal(recovered.extractionValidated, true);
  assert.equal(recovered.failureStage, 'preparing-drive-destination');
}

function testMutationJournalPersistsFailureStageAtProcessingCheckpoints() {
  const context = loadCataloger();
  const extraction = validInvoice();
  const propertyStore = installScriptPropertyStore(context);
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX', context
  ) + 'file-id';
  let fileName = 'invoice.pdf';
  const readJournal = () => JSON.parse(propertyStore.store[journalKey]);
  const file = {
    getId: () => 'file-id',
    getName: () => fileName,
    getSize: () => 10,
    getUrl: () => 'https://drive.test/file-id',
    setName: (name) => {
      assert.equal(readJournal().failureStage, 'renaming-and-moving-pdf');
      assert.equal(readJournal().stage, 'renaming');
      fileName = name;
    },
    moveTo: () => {
      assert.equal(readJournal().failureStage, 'renaming-and-moving-pdf');
      assert.equal(readJournal().stage, 'moving');
    }
  };
  context.sha256ForFile_ = () => 'hash';
  context.extractUtilityData_ = () => extraction;
  context.validateExtraction_ = () => ({ valid: true });
  context.validateServiceIdentityForInvoice_ = () => ({ valid: true });
  context.validateTargetSheetValues_ = () => ({ valid: true });
  context.findDuplicate_ = () => ({ status: 'none' });
  context.buildAssignedName_ = () => 'assigned.pdf';
  context.getDestinationFolder_ = () => ({
    folder: {},
    path: 'Water/2026',
    createdFolders: []
  });
  context.getDestinationCollision_ = () => ({ status: 'none' });
  context.importUtilityInvoiceToSheet_ = () => {
    assert.equal(readJournal().failureStage, 'spreadsheet-write-and-verify');
    return { link: '', sheet: {}, row: 2, created: false };
  };
  context.verifyMovedFile_ = () => {
    assert.equal(readJournal().failureStage, 'renaming-and-moving-pdf');
    assert.equal(readJournal().stage, 'moved');
  };
  context.refreshImportedSourceLink_ = () => {
    assert.equal(readJournal().failureStage, 'verifying-imported-row');
  };
  context.verifyImportedRow_ = () => {
    assert.equal(readJournal().failureStage, 'verifying-imported-row');
    throw new Error('imported-row verification interrupted');
  };
  context.rollbackProcessingMutations_ = (_file, _root, _name, state) => {
    state.rollbackErrors = [];
  };
  context.describeError_ = (error) => error.message;
  context.classifyCatalogErrorForLog_ = () => 'spreadsheet';
  context.logCatalogEvent_ = () => {};

  const result = context.processIntakeFile_(file, {}, 'policy');

  assert.equal(result.failureStage, 'verifying-imported-row');
  assert.equal(readJournal().failureStage, 'verifying-imported-row');
}

function testMutationJournalChunksLargeValidatedExtractionSnapshots() {
  const context = loadCataloger();
  const fileId = 'large-extraction-file-id';
  const chunkSize = vm.runInContext(
    'CONFIG.MUTATION_JOURNAL_PAYLOAD_CHUNK_CHARS', context
  );
  const extraction = {
    ...validInvoice(),
    sheet_values: [{ value: 'x'.repeat(chunkSize * 2) }]
  };
  const { store } = installScriptPropertyStore(context);
  const journalPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX', context
  );
  const payloadPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_EXTRACTION_PAYLOAD_PREFIX', context
  ) + fileId + '_';

  context.saveMutationJournal_(fileId, { extracted: extraction });

  const journal = JSON.parse(store[`${journalPrefix}${fileId}`]);
  assert.equal(journal.extracted, undefined);
  assert.ok(journal.extractedChunks > 1);
  assert.deepEqual(JSON.parse(
    Array.from({ length: journal.extractedChunks }, (_, index) =>
      store[`${payloadPrefix}${index}`]
    ).join('')
  ), extraction);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.hydrateMutationJournalPayload_(
      { getProperty: (key) => store[key] || null }, fileId, journal
    ).extracted)), extraction
  );
}

function testMutationRecoveryPersistsDeletedRowWithFallbackCheckpoint() {
  const fileId = 'source-file-id';
  const initialJournal = {
    stage: 'sheet-marker-written',
    sheetName: 'Water',
    sheetRow: 2,
    sheetRowCreated: true,
    sheetRowPreexisting: false
  };
  const store = {};
  let journalWriteAttempts = 0;
  const context = loadCataloger();
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  ) + fileId;
  store[journalKey] = JSON.stringify(initialJournal);
  const properties = {
    getProperty: (key) => Object.prototype.hasOwnProperty.call(store, key) ?
      store[key] : null,
    setProperty: (key, value) => {
      journalWriteAttempts += 1;
      if (journalWriteAttempts === 1) {
        throw new Error('primary journal update failed');
      }
      store[key] = value;
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => properties
  };
  const file = { getId: () => fileId };
  let markedRow = 2;
  const deletedRows = [];
  let dashboardRefreshes = 0;
  const sheet = {
    getLastRow: () => 4,
    getRange: (row) => ({ row }),
    deleteRow: (row) => {
      deletedRows.push(row);
      markedRow = 0;
    }
  };
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Source file'],
    lookup: { 'source file': 1 }
  });
  context.getHeaderAliases_ = () => ['Source file'];
  context.findHeaderIndex_ = () => 1;
  context.getFileFromSourceCell_ = (cell) =>
    cell.row === markedRow ? file : null;
  context.refreshElectricityDashboardAfterRollback_ = () => {
    dashboardRefreshes += 1;
  };

  assert.equal(
    context.rollbackJournalSheetRow_(initialJournal, file).unmarkedRowMayRemain,
    false
  );
  assert.deepEqual(deletedRows, [2]);
  assert.equal(journalWriteAttempts, 2);
  const fallbackJournal = JSON.parse(store[journalKey]);
  assert.equal(fallbackJournal.stage, 'sheet-row-rolled-back');
  assert.equal(fallbackJournal.sheetRowCreated, false);
  assert.equal(fallbackJournal.sheetRowDeleted, true);
  assert.equal(fallbackJournal.sheetName, 'Water');
  assert.equal(fallbackJournal.sheetRow, 2);
  assert.equal(typeof fallbackJournal.updatedAt, 'number');

  assert.equal(
    context.rollbackJournalSheetRow_(fallbackJournal, file).unmarkedRowMayRemain,
    false
  );
  assert.deepEqual(deletedRows, [2]);
  assert.equal(journalWriteAttempts, 2);
  assert.equal(dashboardRefreshes, 2);
}

function testMutationRecoveryRestoresInitialServiceIdentity() {
  const context = loadCataloger();
  const file = { getId: () => 'file-id' };
  const cells = {
    holder: 'Avery North',
    address: 'Cedar Meridian Boulevard 125 99991 Rivermouth'
  };
  const sheet = {
    getSheetId: () => 7,
    getLastRow: () => 3,
    getRange: (row, column) => ({
      row,
      column,
      getDisplayValue: () => {
        if (row === 1 && column === 5) {
          return cells.holder;
        }
        if (row === 1 && column === 6) {
          return cells.address;
        }
        return '';
      },
      getFormula: () => '',
      setRichTextValue: (value) => {
        if (row === 1 && column === 5) {
          cells.holder = value.text;
        } else if (row === 1 && column === 6) {
          cells.address = value.text;
        }
      }
    }),
    deleteRow: () => {}
  };
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.getSheetLayout_ = () => ({
    headerRow: 2,
    headers: ['Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Account holder', 'Service address', 'Source file'],
    lookup: {
      'account holder': 5,
      'service address': 6,
      'source file': 7
    }
  });
  context.getHeaderAliases_ = (key) => ({
    accountHolder: ['account holder'],
    serviceAddress: ['service address'],
    sourceFile: ['source file']
  }[key] || []);
  context.findHeaderIndex_ = (lookup, aliases) => lookup[aliases[0]] || 0;
  let sourceMarkerFile = file;
  context.getFileFromSourceCell_ = (cell) =>
    cell.row === 3 && cell.column === 7 ? sourceMarkerFile : null;
  context.updateMutationJournal_ = () => {};
  context.refreshElectricityDashboardAfterRollback_ = () => {};

  const journal = {
    stage: 'sheet-written',
    sheetName: 'Water',
    spreadsheetId: 'spreadsheet-id',
    sheetId: 7,
    sheetRow: 3,
    sheetRowCreated: true,
    sheetRowPreexisting: false,
    serviceIdentityBootstrap: {
      metadataRow: 1,
      holderColumn: 5,
      addressColumn: 6,
      previousAccountHolder: 'Enter account holder here',
      previousServiceAddress: 'Enter service address here',
      accountHolder: 'Avery North',
      serviceAddress: 'Cedar Meridian Boulevard 125 99991 Rivermouth'
    },
    serviceIdentityBootstrapCompleted: true
  };

  sheet.getSheetId = () => 8;
  assert.throws(
    () => context.rollbackJournalSheetRow_(journal, file),
    /tab identity no longer matches/
  );
  assert.equal(cells.holder, 'Avery North');
  assert.equal(cells.address, 'Cedar Meridian Boulevard 125 99991 Rivermouth');
  journal.sheetId = 0;
  sheet.getSheetId = () => 0;
  context.rollbackJournalSheetRow_(journal, file);
  assert.equal(cells.holder, 'Enter account holder here');
  assert.equal(cells.address, 'Enter service address here');
  cells.holder = 'Avery North';
  cells.address = 'Cedar Meridian Boulevard 125 99991 Rivermouth';
  journal.sheetId = 7;
  sheet.getSheetId = () => 7;
  sourceMarkerFile = { getId: () => 'different-file-id' };
  assert.throws(
    () => context.rollbackJournalSheetRow_(journal, file),
    /source marker is missing/
  );
  assert.equal(cells.holder, 'Avery North');
  sourceMarkerFile = file;

  context.rollbackJournalSheetRow_(journal, file);

  assert.equal(cells.holder, 'Enter account holder here');
  assert.equal(cells.address, 'Enter service address here');

  cells.holder = 'Manually corrected holder';
  cells.address = 'Manually corrected address';
  assert.throws(
    () => context.rollbackJournalSheetRow_(journal, file),
    /changed since the interrupted import/
  );
  assert.equal(cells.holder, 'Manually corrected holder');
  assert.equal(cells.address, 'Manually corrected address');
}

function testMutationRecoveryReportsUnavailableFileOnce() {
  const context = loadCataloger();
  const extraction = validInvoice();
  const journalPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  );
  const alertPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_RECOVERY_ALERT_PREFIX',
    context
  );
  const fileId = 'unavailable-file-id';
  const extractionPayloadPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_EXTRACTION_PAYLOAD_PREFIX', context
  ) + fileId + '_';
  const store = {
    [`${journalPrefix}${fileId}`]: JSON.stringify({
      originalName: 'unavailable.pdf',
      stage: 'moved',
      extractedChunks: 1,
      extractionValidated: true,
      failureStage: 'verifying-imported-row'
    }),
    [`${extractionPayloadPrefix}0`]: JSON.stringify(extraction)
  };
  const queuedResults = [];
  const properties = {
    getProperties: () => ({ ...store }),
    getProperty: (key) => store[key] || '',
    setProperty: (key, value) => {
      store[key] = value;
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => properties
  };
  context.DriveApp = {
    getFileById: () => {
      throw new Error('Drive file is unavailable');
    }
  };
  context.queuePendingReports_ = (results) => {
    queuedResults.push(...results);
  };
  context.logCatalogEvent_ = () => {};
  context.addOperatorLinksToResult_ = (result) => {
    result.retryUrl = 'https://script.test/retry';
    result.supplierProfilesUrl = 'https://drive.test/profiles';
    return result;
  };

  const firstResults = context.recoverPendingMutations_({});
  const secondResults = context.recoverPendingMutations_({});

  assert.equal(firstResults.length, 1);
  assert.equal(firstResults[0].status, 'ERROR');
  assert.equal(firstResults[0].rollbackCompleted, false);
  assert.match(firstResults[0].problem, /Drive file is unavailable/);
  assert.deepEqual(JSON.parse(JSON.stringify(firstResults[0].extracted)), extraction);
  assert.equal(firstResults[0].extractionValidated, true);
  assert.equal(firstResults[0].failureStage, 'verifying-imported-row');
  assert.equal(firstResults[0].supplySupplier, 'Water / SUPPLIER');
  assert.equal(firstResults[0].retryUrl, 'https://script.test/retry');
  assert.equal(firstResults[0].supplierProfilesUrl, 'https://drive.test/profiles');
  assert.equal(queuedResults.length, 1);
  assert.equal(queuedResults[0].retryUrl, 'https://script.test/retry');
  assert.equal(queuedResults[0].supplierProfilesUrl, 'https://drive.test/profiles');
  assert.equal(secondResults.length, 0);
  assert.ok(store[`${alertPrefix}${fileId}`]);
  assert.ok(store[`${journalPrefix}${fileId}`]);
}

function testRuntimeExhaustionPersistsOperatorLinks() {
  const persisted = [];
  const linked = [];
  const context = loadCataloger();
  vm.runInContext(
    'let runtimeExhaustionClockReads = 0; ' +
      'Date.now = () => runtimeExhaustionClockReads++ === 0 ? 0 : 280000;',
    context
  );
  context.loadIntakeFileState_ = () => ({});
  context.loadTrustedExtractionPolicy_ = () => 'policy';
  context.shouldProcessIntakeFile_ = () => true;
  context.persistCatalogResult_ = (_state, _file, _root, result) => {
    persisted.push(result);
  };
  context.logCatalogEvent_ = () => {};
  context.logCatalogResult_ = () => {};
  context.addOperatorLinksToResult_ = (result) => {
    result.retryUrl = 'https://script.test/retry';
    result.supplierProfilesUrl = 'https://drive.test/profiles';
    linked.push(result);
    return result;
  };

  const file = {
    getId: () => 'timed-out-file',
    getName: () => 'invoice.pdf',
    getUrl: () => 'https://drive.test/timed-out-file'
  };
  const batch = context.processEligibleIntakeFiles_([file], {}, 'event');

  assert.equal(batch.results.length, 1);
  assert.equal(linked.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].retryUrl, 'https://script.test/retry');
  assert.equal(persisted[0].supplierProfilesUrl, 'https://drive.test/profiles');
}

function testTargetMutationJournalRecoveryLeavesUnrelatedJournalUntouched() {
  const context = loadCataloger();
  const journalPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  );
  const targetKey = `${journalPrefix}target-file`;
  const unrelatedKey = `${journalPrefix}unrelated-file`;
  const store = {
    [targetKey]: JSON.stringify({
      originalName: 'original.pdf',
      stage: 'renamed'
    }),
    [unrelatedKey]: JSON.stringify({
      originalName: 'unrelated.pdf',
      stage: 'moved'
    })
  };
  const calls = [];
  let currentName = 'renamed.pdf';
  const file = {
    getName: () => currentName,
    moveTo: () => calls.push('move'),
    setName: (name) => {
      currentName = name;
      calls.push('rename:' + name);
    }
  };
  const properties = {
    getProperty: (key) => store[key] || '',
    deleteProperty: (key) => {
      delete store[key];
      calls.push('delete:' + key);
    },
    setProperty: (key, value) => {
      store[key] = value;
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => properties
  };
  context.DriveApp = {
    getFileById: (fileId) => {
      assert.equal(fileId, 'target-file');
      return file;
    }
  };
  context.isFileInFolder_ = () => false;
  context.rollbackJournalSheetRow_ = () => ({ unmarkedRowMayRemain: false });
  context.buildErrorResult_ = () => ({ status: 'ERROR', actions: '' });
  context.loadIntakeFileState_ = () => ({});
  context.recordIntakeFileOutcome_ = () => calls.push('record-outcome');
  context.queuePendingReports_ = () => calls.push('queue-report');
  context.saveIntakeFileState_ = () => calls.push('save-state');
  context.logCatalogEvent_ = () => calls.push('log-recovered');
  context.addOperatorLinksToResult_ = (result) => {
    result.retryUrl = 'https://script.test/retry';
    result.supplierProfilesUrl = 'https://drive.test/profiles';
    return result;
  };

  const result = context.recoverMutationJournalForFile_(
    {}, 'target-file'
  );

  assert.equal(result.status, 'ERROR');
  assert.equal(currentName, 'original.pdf');
  assert.equal(store[targetKey], undefined);
  assert.ok(store[unrelatedKey]);
  assert.ok(calls.includes('move'));
  assert.ok(calls.includes('record-outcome'));
  assert.ok(calls.includes('queue-report'));
  assert.ok(calls.includes('save-state'));
  assert.ok(calls.includes('log-recovered'));
  assert.equal(result.retryUrl, 'https://script.test/retry');
  assert.equal(result.supplierProfilesUrl, 'https://drive.test/profiles');
}

function testRecoveryMarksUnmarkedRowsAsIncomplete() {
  const context = loadCataloger();
  const fileId = 'unmarked-row-file-id';
  const file = {
    getId: () => fileId,
    getName: () => 'invoice.pdf',
    getUrl: () => 'https://drive.test/unmarked-row-file-id'
  };
  const journalPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX', context
  );
  const propertyStore = installScriptPropertyStore(context, {
    [`${journalPrefix}${fileId}`]: JSON.stringify({
      originalName: 'invoice.pdf',
      stage: 'sheet-insert-planned'
    })
  });
  context.DriveApp = { getFileById: () => file };
  context.isFileInFolder_ = () => true;
  context.rollbackJournalSheetRow_ = () => ({ unmarkedRowMayRemain: true });
  context.recordIntakeFileOutcome_ = () => {};
  context.queuePendingReports_ = () => {};
  context.saveIntakeFileState_ = () => {};
  context.logCatalogEvent_ = () => {};

  const result = context.recoverMutationJournalForFile_({}, fileId);

  assert.equal(result.rollbackCompleted, false);
  assert.match(result.actions, /Automatic rollback was incomplete/);
  assert.match(result.actions, /unmarked spreadsheet row may remain/);
  assert.equal(propertyStore.store[`${journalPrefix}${fileId}`], undefined);
}

function testAccessibleRecoveryFailureRequiresManualReview() {
  const context = loadCataloger();
  const journalPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX', context
  );
  const alertPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_RECOVERY_ALERT_PREFIX', context
  );
  const fileId = 'recoverable-file-id';
  const store = {
    [`${journalPrefix}${fileId}`]: JSON.stringify({
      originalName: 'original.pdf',
      stage: 'sheet-written'
    })
  };
  const file = {
    getId: () => fileId,
    getName: () => 'original.pdf',
    getUrl: () => 'https://drive.test/recoverable-file-id'
  };
  const properties = {
    getProperty: (key) => store[key] || '',
    setProperty: (key, value) => {
      store[key] = value;
    }
  };
  context.PropertiesService = { getScriptProperties: () => properties };
  context.DriveApp = { getFileById: () => file };
  context.isFileInFolder_ = () => true;
  context.rollbackJournalSheetRow_ = () => {
    throw new Error('source marker is missing');
  };
  context.recordIntakeFileOutcome_ = () => {};
  context.queuePendingReports_ = () => {};
  context.saveIntakeFileState_ = () => {};
  context.logCatalogEvent_ = () => {};

  const result = context.recoverMutationJournalForFile_(
    {}, fileId, store[`${journalPrefix}${fileId}`], {}, properties
  );

  assert.equal(result.status, 'ERROR');
  assert.equal(result.rollbackCompleted, false);
  assert.match(result.actions, /spreadsheet row may remain/);
  assert.ok(store[`${alertPrefix}${fileId}`]);
}

function testFormulaAndStyleCopySources() {
  const calls = [];
  const context = loadCataloger();
  const sheet = {
    getLastRow: () => 6,
    getRange: (row, column, _rows, width) => ({
      copyTo: (_target, pasteType) => calls.push([row, pasteType]),
      getFormulas: () => [['', '=A1', '']],
      clearContent: () => calls.push([row, column, width, 'clear'])
    })
  };
  const layout = { headerRow: 1, headers: ['A', 'B'] };

  context.copyRowStyleAndFormulas_(sheet, 4, layout);
  context.copyRowStyleAndFormulas_(sheet, 2, layout);

  assert.deepEqual(calls, [
    [3, 'format'],
    [3, 'formula'],
    [4, 1, 1, 'clear'],
    [4, 3, 1, 'clear'],
    [3, 'format'],
    [3, 'formula'],
    [2, 1, 1, 'clear'],
    [2, 3, 1, 'clear']
  ]);
}

function testExistingFormulaCellsAreNotOverwrittenDuringReimport() {
  const writes = [];
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['Issue date'],
    supplier: ['Supplier'],
    identifier: ['Invoice number'],
    contractNumber: ['Contract number'],
    customerCode: ['Customer code'],
    year: ['Reference year'],
    month: ['Reference month'],
    frequency: ['Frequency'],
    consumptionCost: ['Total consumption costs'],
    nonConsumptionCosts: ['Total non-consumption costs'],
    vat: ['VAT'],
    total: ['Total cost'],
    sourceFile: ['Source file']
  })[key] || [];
  context.buildDrivePathLabel_ = () => 'invoice.pdf';
  const layout = {
    headerRow: 1,
    headers: ['Issue date', 'Supplier', 'Source file', 'Calculated value'],
    lookup: {
      'issue date': 1,
      supplier: 2,
      'source file': 3,
      'calculated value': 4
    }
  };
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 4) {
        return { getFormulas: () => [[
          '', '=UPPER("supplier")', '=HYPERLINK("url","text")', '=A3*2'
        ]] };
      }
      return {
        setFormula: (value) => writes.push([row, column, 'formula', value]),
        setRichTextValue: (value) => writes.push([row, column, 'rich', value]),
        setValue: (value) => writes.push([row, column, 'value', value])
      };
    }
  };

  context.writeInvoiceRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file' }, validInvoice());

  assert.equal(writes.some((entry) => entry[1] === 2), false);
  assert.equal(writes.some((entry) => entry[1] === 4), false);
  assert.equal(writes.some((entry) => entry[1] === 1), true);
  assert.equal(writes.some((entry) => entry[1] === 3 && entry[2] === 'formula'),
    true);
}

function testDetailedCostSheetValuesOverrideBroadReconciliationValues() {
  const writes = [];
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    issueDate: ['Issue date'],
    supplier: ['Supplier'],
    identifier: ['Invoice number'],
    contractNumber: ['Contract number'],
    customerCode: ['Customer code'],
    year: ['Reference year'],
    month: ['Reference month'],
    frequency: ['Frequency'],
    consumptionCost: ['Total consumption costs'],
    nonConsumptionCosts: ['Total non-consumption costs'],
    vat: ['VAT'],
    total: ['Total cost'],
    sourceFile: ['Source file']
  })[key] || [];
  context.buildDrivePathLabel_ = () => 'invoice.pdf';
  const layout = {
    headerRow: 1,
    headers: [
      'Total consumption costs', 'Collection charges', 'Discounts',
      'Wi-Fi extender', 'Total non-consumption costs', 'VAT', 'Total cost',
      'Source file'
    ],
    lookup: {
      'total consumption costs': 1,
      'collection charges': 2,
      discounts: 3,
      'wi fi extender': 4,
      'total non-consumption costs': 5,
      vat: 6,
      'total cost': 7,
      'source file': 8
    }
  };
  const formulas = ['', '', '', '', '=B3+C3+D3', '', '=A3+E3+F3', ''];
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 8) {
        return { getFormulas: () => [formulas] };
      }
      return {
        setFormula: (value) => writes.push([row, column, 'formula', value]),
        setRichTextValue: (value) => writes.push([row, column, 'rich', value]),
        setValue: (value) => writes.push([row, column, 'value', value])
      };
    }
  };
  const extracted = {
    ...validInvoice(),
    cost_consumption: 0,
    cost_non_consumption: 21.29,
    vat: 4.68,
    total: 25.97,
    sheet_values: [
      { header: 'Total consumption costs', value: 25.99 },
      { header: 'Collection charges', value: 0 },
      { header: 'Discounts', value: -4 },
      { header: 'Wi-Fi extender', value: 3.98 },
      { header: 'VAT', value: 0 }
    ]
  };

  context.writeInvoiceRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file' }, extracted);

  assert.deepEqual(writes.filter((entry) => entry[2] === 'value').sort(
    (left, right) => left[1] - right[1]
  ), [
    [3, 1, 'value', 25.99],
    [3, 2, 'value', 0],
    [3, 3, 'value', -4],
    [3, 4, 'value', 3.98],
    [3, 6, 'value', 0]
  ]);

  const actualValues = [25.99, 0, -4, 3.98, -0.02, 0, 25.97, 'invoice'];
  const verificationSheet = {
    getLastRow: () => 3,
    getRange: (_row, column, _rows, width) => {
      if (column === 1 && width === 8) {
        return { getFormulas: () => [formulas] };
      }
      return {
        getValue: () => actualValues[column - 1],
        getRichTextValue: () => null,
        getFormula: () => column === 8 ?
          '=HYPERLINK("https://drive.test/file";"invoice")' : formulas[column - 1],
        getDisplayValue: () => 'invoice'
      };
    }
  };
  assert.doesNotThrow(() => context.verifyImportedRow_(verificationSheet, 3,
    layout, { getUrl: () => 'https://drive.test/file' }, extracted));
}

function testSupplementarySheetValuesCannotOverrideLiteralCanonicalFields() {
  const writes = [];
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    identifier: ['Invoice number'],
    contractNumber: ['Contract number'],
    customerCode: ['Customer code'],
    month: ['Reference month'],
    sourceFile: ['Source file']
  })[key] || [];
  context.buildDrivePathLabel_ = () => 'invoice.pdf';
  const layout = {
    headerRow: 1,
    headers: ['Invoice number', 'Contract number', 'Customer code',
      'Reference month', 'Source file'],
    lookup: {
      'invoice number': 1,
      'contract number': 2,
      'customer code': 3,
      'reference month': 4,
      'source file': 5
    }
  };
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 5) {
        return { getFormulas: () => [['', '', '', '', '']] };
      }
      return {
        setFormula: (value) => writes.push([row, column, 'formula', value]),
        setRichTextValue: (value) => writes.push([row, column, 'rich', value]),
        setValue: (value) => writes.push([row, column, 'value', value])
      };
    }
  };
  const extracted = {
    ...validInvoice(),
    identifier: 'INV-01',
    contract_number: 'CON-01',
    customer_code: '00053009296',
    reference_month: '09',
    sheet_values: [
      { header: 'Customer code', value: 53009296 },
      { header: 'Reference month', value: 9 }
    ]
  };

  context.writeInvoiceRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file' }, extracted);

  assert.deepEqual(writes.filter((entry) => entry[2] === 'rich').map(
    (entry) => [entry[1], entry[3].text]
  ).slice(-4), [[1, 'INV-01'], [2, 'CON-01'], [3, '00053009296'], [4, '09']]);
  assert.equal(writes.some((entry) => entry[2] === 'value' && entry[1] <= 4),
    false);
}

function testVerifyImportedRowKeepsExtractedIdentityAgainstSheetValues() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    identifier: ['Identifier'],
    contractNumber: ['Contract number'],
    accountHolder: ['Account holder'],
    serviceAddress: ['Service address'],
    customerCode: ['Customer code'],
    month: ['Reference month'],
    sourceFile: ['Source file']
  })[key] || [];
  const layout = {
    headerRow: 1,
    headers: ['Identifier', 'Contract number', 'Account holder',
      'Service address', 'Customer code', 'Reference month', 'Source file'],
    lookup: {
      identifier: 1,
      'contract number': 2,
      'account holder': 3,
      'service address': 4,
      'customer code': 5,
      'reference month': 6,
      'source file': 7
    }
  };
  const extracted = {
    ...validInvoice(),
    sheet_values: [
      { header: 'Identifier', value: 'Wrong identifier' },
      { header: 'Contract number', value: 'Wrong contract number' },
      { header: 'Account holder', value: 'Wrong account holder' },
      { header: 'Service address', value: 'Wrong service address' },
      { header: 'Customer code', value: 'Wrong customer code' },
      { header: 'Reference month', value: '01' }
    ]
  };
  const actualValues = [extracted.identifier, extracted.contract_number,
    extracted.account_holder, extracted.address_evidence, extracted.customer_code,
    extracted.reference_month, 'invoice'];
  const sheet = {
    getLastRow: () => 2,
    getRange: (_row, column, _rows, width) => {
      if (width === 7) {
        return { getFormulas: () => [['', '', '', '', '', '', '']] };
      }
      return {
        getValue: () => actualValues[column - 1],
        getRichTextValue: () => null,
        getFormula: () => column === 7 ?
          '=HYPERLINK("https://drive.test/file-id";"invoice")' : '',
        getDisplayValue: () => column === 7 ? 'invoice' : actualValues[column - 1]
      };
    }
  };

  assert.doesNotThrow(() => context.verifyImportedRow_(sheet, 2, layout,
    { getUrl: () => 'https://drive.test/file-id' }, extracted));
}

function testMissingRowFormulaDoesNotUnprotectTemplateColumn() {
  const writes = [];
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    total: ['Total cost'],
    sourceFile: ['Source file']
  })[key] || [];
  context.buildDrivePathLabel_ = () => 'invoice.pdf';
  const layout = {
    headerRow: 1,
    headers: ['Total cost', 'Source file'],
    lookup: { 'total cost': 1, 'source file': 2 }
  };
  const sheet = {
    getLastRow: () => 3,
    getParent: () => ({ getSpreadsheetLocale: () => 'en_US' }),
    getRange: (row, column, _rows, width) => {
      if (column === 1 && width === 2) {
        return { getFormulas: () => [row === 3 ? ['', ''] : ['=A2*2', '']] };
      }
      return {
        setFormula: (value) => writes.push([row, column, 'formula', value]),
        setRichTextValue: (value) => writes.push([row, column, 'rich', value]),
        setValue: (value) => writes.push([row, column, 'value', value])
      };
    }
  };

  context.writeInvoiceRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file' }, validInvoice());

  assert.equal(writes.some((entry) => entry[1] === 1), false);
  assert.equal(writes.some((entry) => entry[1] === 2 && entry[2] === 'formula'),
    true);
}

function testSourceHyperlinkFormulaIsPreserved() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => key === 'sourceFile' ? ['Source file'] : [];
  const sheet = {
    getRange: (row) => ({
      getFormulas: () => [['=HYPERLINK("url";"text")']],
      getFormula: () => '=HYPERLINK("https://drive.test/file-id";"text")',
      getDisplayValue: () => 'text',
      getRichTextValue: () => null
    })
  };

  const extracted = validInvoice();
  extracted.sheet_values = [];

  context.verifyImportedRow_(
    sheet,
    3,
    { headerRow: 1, headers: ['Source file'], lookup: { 'source file': 1 } },
    { getUrl: () => 'https://drive.test/file-id' },
    extracted
  );
}

function testExistingInvoicePayloadRestoresAndRepositions() {
  const context = loadCataloger();
  const layout = { headers: ['Date', 'Source', 'Total', 'Notes'], lookup: {} };
  const originalDate = new Date('2026-04-09T00:00:00Z');
  const originalNumberFormats = ['dd/MM/yyyy', '@', '#,##0.00', '@'];
  const writes = [];
  const moves = [];
  const sourceRow = { row: 9, column: 1, numRows: 1, numColumns: 4 };
  const sheet = {
    getRange: (row, column, numRows, numColumns) => {
      if (numRows && numColumns) {
        if (row === 9) {
          return {
            ...sourceRow,
            getValues: () => [[originalDate, 'ignored', 14.64, '=untrusted']],
            getFormulas: () => [['', '=HYPERLINK("url";"invoice")', '', '']],
            getNumberFormats: () => [originalNumberFormats]
          };
        }
        return { row, column, numRows, numColumns };
      }
      return {
        setFormula: (value) => writes.push(['formula', row, column, value]),
        setValue: (value) => writes.push(['value', row, column, value]),
        setRichTextValue: (value) => writes.push(['rich', row, column, value]),
        setNumberFormat: (value) => writes.push(['number-format', row, column, value])
      };
    },
    moveRows: (range, destination) => moves.push([range, destination])
  };
  const payload = context.captureImportedRowPayload_(sheet, 9, layout);
  let findCalls = 0;
  context.findSpreadsheetRowBySourceFile_ = () => {
    findCalls += 1;
    return findCalls === 1 ? 9 : 4;
  };
  context.restoreImportedRowPayload_(sheet, 9, 4, payload,
    { getId: () => 'file-id' }, layout);
  assert.equal(moves.length, 1);
  assert.equal(moves[0][1], 4);
  const restoredValues = writes.filter((entry) => entry[0] !== 'number-format');
  assert.equal(restoredValues[0][0], 'value');
  assert.equal(Object.prototype.toString.call(restoredValues[0][3]), '[object Date]');
  assert.deepEqual(restoredValues[1], ['formula', 4, 2,
    '=HYPERLINK("url";"invoice")']);
  assert.deepEqual(restoredValues[2], ['value', 4, 3, 14.64]);
  assert.equal(restoredValues[3][0], 'rich');
  assert.equal(restoredValues[3][3].text, '=untrusted');
  assert.deepEqual(writes.filter((entry) => entry[0] === 'number-format').map(
    (entry) => entry[3]
  ), originalNumberFormats);

  context.getInsertionRow_ = () => 12;
  context.findSpreadsheetRowBySourceFile_ = () => 11;
  assert.equal(context.repositionImportedRow_(sheet, 9, layout,
    '2026-05-08', { getId: () => 'file-id' }), 11);
  assert.equal(moves[1][1], 12);
}

function testExistingInvoiceRollbackRestoresNumberFormatAfterFailedReplacement() {
  const context = loadCataloger();
  const originalNumberFormat = '00000000';
  let numberFormat = originalNumberFormat;
  const layout = {
    headerRow: 1,
    headers: ['Contract number', 'Source file'],
    lookup: { 'contract number': 1, 'source file': 2 }
  };
  const sheet = {
    getSheetId: () => 7,
    getRange: (row, column, numRows, numColumns) => {
      if (numRows === 1 && numColumns === 2) {
        return {
          getValues: () => [['00001234', 'ignored']],
          getFormulas: () => [['', '=HYPERLINK("url";"invoice")']],
          getNumberFormats: () => [[numberFormat, '@']]
        };
      }
      return {
        setFormula: () => {},
        setRichTextValue: () => {},
        setValue: () => {},
        setNumberFormat: (value) => {
          if (column === 1) {
            numberFormat = value;
          }
        }
      };
    }
  };
  context.getAutomationConfig_ = () => ({ sheet_by_supply: { Water: 'Water' } });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet,
    getUrl: () => 'https://sheets.test/spreadsheet-id'
  });
  context.captureElectricityDashboardLayoutsForRollback_ = () => null;
  context.getSheetLayout_ = () => layout;
  context.findSpreadsheetRowBySourceFile_ = () => 2;
  context.clearImportedLiteralCells_ = () => {};
  context.updateMutationJournal_ = () => {};
  context.refreshElectricityDashboardAfterRollback_ = () => {};
  context.writeInvoiceRow_ = () => {
    context.setTextValueForHeaders_(sheet, 2, layout, [false, false],
      ['Contract number'], '00005678');
    throw new Error('replacement failed');
  };

  assert.throws(() => context.importUtilityInvoiceToSheet_(
    { getId: () => 'file-id' }, validInvoice()
  ), /replacement failed/);
  assert.equal(numberFormat, originalNumberFormat);
}

function testFirstInvoiceImportEstablishesServiceIdentityControls() {
  const context = loadCataloger();
  const cells = [
    ['Controllo fornitura', 'Water', '', '', 'Enter account holder here',
      'Enter service address here'],
    ['Issue date', 'Supplier', 'Invoice number', 'Contract number',
      'Account holder', 'Service address', 'Source file']
  ];
  let lastRow = 2;
  const sheet = {
    getName: () => 'Water',
    getSheetId: () => 7,
    getLastRow: () => lastRow,
    getRange: (row, column) => ({
      getDisplayValue: () => String((cells[row - 1] || [])[column - 1] || ''),
      getFormula: () => '',
      setValue: (value) => {
        cells[row - 1] = cells[row - 1] || [];
        cells[row - 1][column - 1] = value;
      },
      setRichTextValue: (value) => {
        cells[row - 1] = cells[row - 1] || [];
        cells[row - 1][column - 1] = value.text;
      }
    }),
    deleteRow: () => { lastRow -= 1; }
  };
  const layout = {
    headerRow: 2,
    headers: cells[1],
    lookup: {
      'issue date': 1,
      supplier: 2,
      'invoice number': 3,
      'contract number': 4,
      'account holder': 5,
      'service address': 6,
      'source file': 7
    }
  };
  context.getAutomationConfig_ = () => ({
    locale: 'en',
    sheet_by_supply: { Water: 'Water' }
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet,
    getUrl: () => 'https://sheets.test/spreadsheet-id'
  });
  context.getSheetLayout_ = () => layout;
  context.captureElectricityDashboardLayoutsForRollback_ = () => null;
  context.findSpreadsheetRowBySourceFile_ = () => 0;
  context.getInsertionRow_ = () => 3;
  context.insertBlankRowAt_ = () => { lastRow += 1; };
  context.copyRowStyleAndFormulas_ = () => {};
  context.refreshImportedSourceLink_ = () => {};
  context.writeInvoiceRow_ = () => {};
  context.verifyImportedRow_ = () => {};
  context.refreshElectricityDashboardAfterInvoiceImport_ = () => null;
  context.updateMutationJournal_ = () => {};

  context.importUtilityInvoiceToSheet_(
    { getId: () => 'file-id' }, validInvoice(), {}
  );

  assert.equal(cells[0][4], 'Avery North');
  assert.equal(cells[0][5], 'Cedar Meridian Boulevard 125 99991 Rivermouth');
}

function testCorrectedInvoiceMovesImmediatelyBeforeNewerInvoice() {
  const context = loadCataloger();
  const moves = [];
  const dates = {
    2: '2026-05-15',
    3: '2026-03-01',
    4: '2026-04-01',
    5: '2026-06-01'
  };
  const sheet = {
    getLastRow: () => 5,
    getRange: (row, column, numRows, numColumns) => ({
      row,
      column,
      numRows,
      numColumns,
      getValue: () => dates[row]
    }),
    moveRows: (range, destination) => moves.push([range, destination])
  };
  const layout = {
    headerRow: 1,
    headers: ['Issue date', 'Source file'],
    lookup: { 'issue date': 1, 'source file': 2 }
  };
  context.getHeaderAliases_ = (key) =>
    key === 'issueDate' ? ['Issue date'] : [];
  context.findSpreadsheetRowBySourceFile_ = () => 4;

  assert.equal(context.repositionImportedRow_(sheet, 2, layout,
    '2026-05-15', { getId: () => 'file-id' }), 4);
  assert.equal(moves.length, 1);
  assert.equal(moves[0][1], 5);
}

function testCorrectedInvoiceAppendsWithoutBlankRow() {
  const context = loadCataloger();
  const moves = [];
  const dates = {
    2: '2026-07-01',
    3: '2026-03-01',
    4: '2026-04-01',
    5: '2026-06-01'
  };
  const sheet = {
    getLastRow: () => 5,
    getRange: (row, column, numRows, numColumns) => ({
      row,
      column,
      numRows,
      numColumns,
      getValue: () => dates[row]
    }),
    moveRows: (range, destination) => moves.push([range, destination])
  };
  const layout = {
    headerRow: 1,
    headers: ['Issue date', 'Source file'],
    lookup: { 'issue date': 1, 'source file': 2 }
  };
  context.getHeaderAliases_ = (key) =>
    key === 'issueDate' ? ['Issue date'] : [];
  context.findSpreadsheetRowBySourceFile_ = () => 5;

  assert.equal(context.repositionImportedRow_(sheet, 2, layout,
    '2026-07-01', { getId: () => 'file-id' }), 5);
  assert.equal(moves.length, 1);
  assert.equal(moves[0][1], 6);
}

function createInsertedInvoiceRollbackFixture(deleteRow) {
  const context = loadCataloger();
  const file = { getId: () => 'file-id' };
  const sheet = {
    getName: () => 'Water',
    getSheetId: () => 7,
    deleteRow: deleteRow
  };
  context.getAutomationConfig_ = () => ({
    sheet_by_supply: { Water: 'Water' }
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet,
    getUrl: () => 'https://sheets.test/spreadsheet-id'
  });
  context.getSheetLayout_ = () => ({
    headerRow: 1,
    headers: ['Issue date'],
    lookup: {}
  });
  context.validateServiceIdentityForInvoice_ = () => ({ valid: true });
  context.captureElectricityDashboardLayoutsForRollback_ = () => null;
  context.findSpreadsheetRowBySourceFile_ = () => 0;
  context.getInsertionRow_ = () => 2;
  context.insertBlankRowAt_ = () => {};
  context.copyRowStyleAndFormulas_ = () => {};
  context.refreshImportedSourceLink_ = () => {};
  context.writeInvoiceRow_ = () => {};
  context.verifyImportedRow_ = () => {};
  context.refreshElectricityDashboardAfterInvoiceImport_ = () => {};
  context.refreshElectricityDashboardAfterRollback_ = () => {};
  const propertyStore = installScriptPropertyStore(context);
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  ) + file.getId();
  return {
    context,
    file,
    journalKey,
    sheet,
    store: propertyStore.store
  };
}

function testInsertedInvoiceDeleteFailureBeforeMarkerPreservesJournalState() {
  const fixture = createInsertedInvoiceRollbackFixture(() => {
    throw new Error('row deletion failed');
  });
  fixture.context.copyRowStyleAndFormulas_ = () => {
    throw new Error('style copy failed');
  };

  assert.throws(
    () => fixture.context.importUtilityInvoiceToSheet_(
      fixture.file, validInvoice()
    ),
    /style copy failed.*row deletion failed/
  );
  const journal = JSON.parse(fixture.store[fixture.journalKey]);
  assert.equal(journal.stage, 'sheet-insert-planned');
  assert.equal(journal.sheetRowCreated, false);
  assert.equal(journal.sheetRowDeleted, undefined);
}

function testInsertedInvoiceDeleteFailureAfterMarkerPreservesJournalState() {
  const fixture = createInsertedInvoiceRollbackFixture(() => {
    throw new Error('row deletion failed');
  });
  fixture.context.writeInvoiceRow_ = () => {
    throw new Error('invoice write failed');
  };

  assert.throws(
    () => fixture.context.importUtilityInvoiceToSheet_(
      fixture.file, validInvoice()
    ),
    /invoice write failed.*row deletion failed/
  );
  const journal = JSON.parse(fixture.store[fixture.journalKey]);
  assert.equal(journal.stage, 'sheet-marker-written');
  assert.equal(journal.sheetRowCreated, true);
  assert.equal(journal.sheetRowDeleted, undefined);
}

function testExpectedBootstrapChangeAbortsBeforeRowInsertion() {
  const fixture = createInsertedInvoiceRollbackFixture(() => {});
  let inserted = false;
  fixture.context.insertBlankRowAt_ = () => { inserted = true; };
  fixture.context.validateServiceIdentityForInvoice_ = () => ({
    valid: false,
    problem: 'The target supply has no configured account holder or service address.'
  });

  assert.throws(
    () => fixture.context.importUtilityInvoiceToSheet_(
      fixture.file, validInvoice(), { initialServiceIdentityBootstrapExpected: true }
    ),
    /could not be revalidated/
  );
  assert.equal(inserted, false);
}

function testExpectedBootstrapChangeAbortsBeforeExistingRowReplacement() {
  const context = loadCataloger();
  let replacementStarted = false;
  const sheet = { getName: () => 'Water', getSheetId: () => 7 };
  context.getAutomationConfig_ = () => ({ sheet_by_supply: { Water: 'Water' } });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet,
    getUrl: () => 'https://sheets.test/spreadsheet-id'
  });
  context.captureElectricityDashboardLayoutsForRollback_ = () => null;
  context.getSheetLayout_ = () => ({ headerRow: 1, headers: [], lookup: {} });
  context.prepareInitialServiceIdentityBootstrap_ = () => null;
  context.validateServiceIdentityForInvoice_ = () => ({
    valid: false,
    problem: 'The target supply has no configured account holder or service address.'
  });
  context.findSpreadsheetRowBySourceFile_ = () => 2;
  context.writeInvoiceRow_ = () => { replacementStarted = true; };
  context.updateMutationJournal_ = () => {};

  assert.throws(
    () => context.importUtilityInvoiceToSheet_(
      { getId: () => 'file-id' }, validInvoice(),
      { initialServiceIdentityBootstrapExpected: true }
    ),
    /could not be revalidated/
  );
  assert.equal(replacementStarted, false);
}

function testBootstrapBoundaryRejectsNewRowsBeforeInsertion() {
  const context = loadCataloger();
  let lastRow = 2;
  const cells = ['Controllo fornitura', 'Water', '', '',
    'Enter account holder here', 'Enter service address here'];
  const sheet = {
    getName: () => 'Water',
    getLastRow: () => lastRow,
    getRange: (_row, column) => ({
      getDisplayValue: () => cells[column - 1] || '',
      getFormula: () => ''
    })
  };
  context.getAutomationConfig_ = () => ({ sheet_by_supply: { Water: 'Water' } });
  context.getSheetLayout_ = () => ({
    headerRow: 2,
    lookup: { 'account holder': 5, 'service address': 6 }
  });
  context.getHeaderAliases_ = (key) => ({
    accountHolder: ['account holder'], serviceAddress: ['service address']
  }[key] || []);
  context.findHeaderIndex_ = (lookup, aliases) => lookup[aliases[0]] || 0;
  const bootstrap = {
    sheet,
    supplyType: 'Water',
    metadataRow: 1,
    holderColumn: 5,
    addressColumn: 6,
    previousAccountHolder: 'Enter account holder here',
    previousServiceAddress: 'Enter service address here'
  };
  lastRow = 3;
  assert.throws(
    () => context.assertInitialServiceIdentityBootstrapBoundary_(bootstrap),
    /boundary changed/
  );
}

function testInsertedInvoiceRetainsRowWhenDashboardRefreshWarns() {
  const context = loadCataloger();
  const deletedRows = [];
  const sheet = {
    getName: () => 'Electricity',
    getSheetId: () => 7,
    deleteRow: (row) => deletedRows.push(row)
  };
  const layout = { headerRow: 1, headers: ['Issue date'], lookup: {} };
  context.getAutomationConfig_ = () => ({
    sheet_by_supply: { Electricity: 'Electricity' }
  });
  context.getSpreadsheetId_ = () => 'spreadsheet-id';
  context.SpreadsheetApp.openById = () => ({
    getSheetByName: () => sheet,
    getUrl: () => 'https://sheets.test/spreadsheet-id'
  });
  context.getSheetLayout_ = () => layout;
  let dashboardLogs = 0;
  context.captureElectricityDashboardLayoutsForRollback_ = () => {
    throw new Error('dashboard layout capture failed');
  };
  context.logCatalogEvent_ = () => { dashboardLogs += 1; };
  context.classifyCatalogErrorForLog_ = () => 'spreadsheet';
  context.findSpreadsheetRowBySourceFile_ = () => 0;
  context.getInsertionRow_ = () => 2;
  context.updateMutationJournal_ = () => {};
  context.insertBlankRowAt_ = () => {};
  context.copyRowStyleAndFormulas_ = () => {};
  context.refreshImportedSourceLink_ = () => {};
  context.writeInvoiceRow_ = () => {};
  context.verifyImportedRow_ = () => {};
  assert.throws(() => context.importUtilityInvoiceToSheet_(
    { getId: () => 'file-id' }, validInvoice()
  ), /dashboard layout capture failed/);
  assert.deepEqual(deletedRows, []);
  assert.equal(dashboardLogs, 1);

  context.captureElectricityDashboardLayoutsForRollback_ = () => ({
    monthlyF1: { sourceRanges: ['F1:Z13'] }
  });
  context.refreshElectricityDashboardAfterInvoiceImport_ = () => {
    return { warning: 'Electricity dashboard refresh failed; imported invoice data was retained.' };
  };
  let rollbackRefreshes = 0;
  context.refreshElectricityDashboardAfterRollback_ = (state) => {
    assert.equal(state.sheet, sheet);
    assert.equal(JSON.stringify(state.electricityDashboardLayouts), JSON.stringify({
      monthlyF1: { sourceRanges: ['F1:Z13'] }
    }));
    rollbackRefreshes += 1;
  };
  const result = context.importUtilityInvoiceToSheet_(
    { getId: () => 'file-id' }, validInvoice()
  );
  assert.equal(result.dashboardWarning,
    'Electricity dashboard refresh failed; imported invoice data was retained.');
  assert.deepEqual(deletedRows, []);
  assert.equal(rollbackRefreshes, 0);
  assert.equal(dashboardLogs, 1);
}

function testDashboardRollbackForcesRegeneration() {
  const context = loadCataloger();
  const spreadsheet = {};
  let regenerated = 0;
  context.getAutomationConfig_ = () => ({
    locale: 'en',
    sheet_by_supply: { electricity: 'Electricity' }
  });
  context.getElectricitySupplySheetName_ = (config) =>
    config.sheet_by_supply.electricity;
  const preservedLayouts = { monthlyF1: { sourceRanges: ['F1:Z13'] } };
  context.initializeElectricityDashboard_ = (target, config, options) => {
    assert.equal(target, spreadsheet);
    assert.equal(config.locale, 'en');
    assert.equal(options.preservedLayouts, preservedLayouts);
    regenerated += 1;
  };
  context.refreshElectricityDashboardAfterRollback_({
    sheet: {
      getName: () => 'Electricity',
      getParent: () => spreadsheet
    },
    extracted: validInvoice(),
    electricityDashboardLayouts: preservedLayouts
  });
  assert.equal(regenerated, 1);

  context.refreshElectricityDashboardAfterRollback_({
    sheet: {
      getName: () => 'Water',
      getParent: () => spreadsheet
    }
  });
  assert.equal(regenerated, 1);
}

function testRowDeletionIsJournaledBeforeDashboardRollback() {
  const context = loadCataloger();
  const journalUpdates = [];
  const state = {
    moved: false,
    renamed: false,
    imported: true,
    sheetRowCreated: true,
    sheetRowPreexisting: false,
    sheetLink: 'https://sheets.test',
    sheet: {},
    sheetRow: 4
  };
  context.rollbackImportedRow_ = () => {};
  context.updateMutationJournal_ = (fileId, changes) => {
    journalUpdates.push([fileId, changes]);
  };
  context.refreshElectricityDashboardAfterRollback_ = () => {
    throw new Error('dashboard refresh failed');
  };

  context.rollbackProcessingMutations_({ getId: () => 'file-id' }, {}, 'invoice.pdf',
    state);

  assert.equal(state.sheetRowCreated, false);
  assert.equal(state.imported, false);
  assert.equal(JSON.stringify(journalUpdates), JSON.stringify([['file-id', {
    stage: 'sheet-row-rolled-back',
    sheetRowCreated: false,
    sheetRowDeleted: true
  }]]));
  assert.equal(state.rollbackErrors.length, 1);
}

function testOuterRollbackUsesFullJournalFallbackCheckpoint() {
  const context = loadCataloger();
  const file = { getId: () => 'file-id' };
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  ) + file.getId();
  const initialJournal = {
    stage: 'moved',
    originalName: 'invoice.pdf',
    sheetName: 'Water',
    sheetRow: 4,
    sheetRowCreated: true,
    sheetRowPreexisting: false
  };
  const propertyStore = installScriptPropertyStore(context, {
    [journalKey]: JSON.stringify(initialJournal)
  });
  let deletionAttempts = 0;
  let primaryCheckpointAttempts = 0;
  let dashboardRefreshes = 0;
  context.rollbackImportedRow_ = () => {
    deletionAttempts += 1;
  };
  context.updateMutationJournal_ = () => {
    primaryCheckpointAttempts += 1;
    throw new Error('primary checkpoint failed');
  };
  context.refreshElectricityDashboardAfterRollback_ = () => {
    dashboardRefreshes += 1;
  };
  const state = {
    moved: false,
    renamed: false,
    imported: true,
    sheetRowCreated: true,
    sheetRowPreexisting: false,
    sheetLink: 'https://sheets.test',
    sheet: {},
    sheetRow: 4
  };

  context.rollbackProcessingMutations_(file, {}, 'invoice.pdf', state);

  assert.equal(deletionAttempts, 1);
  assert.equal(primaryCheckpointAttempts, 1);
  assert.equal(dashboardRefreshes, 1);
  assert.equal(state.imported, false);
  assert.equal(state.sheetRowCreated, false);
  assert.equal(state.sheetLink, '');
  assert.equal(state.rollbackErrors.length, 0);
  const journal = JSON.parse(propertyStore.store[journalKey]);
  assert.equal(journal.stage, 'sheet-row-rolled-back');
  assert.equal(journal.sheetRowCreated, false);
  assert.equal(journal.sheetRowDeleted, true);
  assert.equal(journal.originalName, 'invoice.pdf');
  assert.equal(journal.sheetName, 'Water');
  assert.equal(journal.sheetRow, 4);
  assert.equal(typeof journal.updatedAt, 'number');
}

function testOuterRollbackDoesNotCheckpointMissingRowLocation() {
  const context = loadCataloger();
  const file = { getId: () => 'file-id' };
  const journalKey = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.MUTATION_JOURNAL_PREFIX',
    context
  ) + file.getId();
  const initialJournal = {
    stage: 'sheet-marker-written',
    sheetName: 'Water',
    sheetRow: 4,
    sheetRowCreated: true
  };
  const propertyStore = installScriptPropertyStore(context, {
    [journalKey]: JSON.stringify(initialJournal)
  });
  let checkpointAttempts = 0;
  context.updateMutationJournal_ = () => {
    checkpointAttempts += 1;
  };
  context.rollbackProcessingMutations_(file, {}, 'invoice.pdf', {
    moved: false,
    renamed: false,
    imported: true,
    sheetRowCreated: true,
    sheetRowPreexisting: false,
    sheetLink: 'https://sheets.test',
    sheet: null,
    sheetRow: 0
  });

  assert.equal(checkpointAttempts, 0);
  const journal = JSON.parse(propertyStore.store[journalKey]);
  assert.equal(journal.stage, 'sheet-marker-written');
  assert.equal(journal.sheetRowCreated, true);
  assert.equal(journal.sheetRowDeleted, undefined);
}

function testMutationJournalPayloadUsesSeparateChunks() {
  const context = loadCataloger();
  const store = {};
  const properties = {
    getProperties: () => ({ ...store }),
    getProperty: (key) => Object.prototype.hasOwnProperty.call(store, key) ?
      store[key] : null,
    setProperty: (key, value) => { store[key] = value; },
    setProperties: (values) => Object.assign(store, values),
    deleteProperty: (key) => { delete store[key]; }
  };
  const payload = { cells: [{ value: { type: 'value', value: 'x'.repeat(5000) } }] };
  const count = context.writeMutationJournalPayload_(properties, 'file-id', payload);
  assert.equal(count > 1, true);
  const journal = context.hydrateMutationJournalPayload_(properties, 'file-id', {
    sheetRowPayloadChunks: count
  });
  assert.equal(journal.sheetRowPayload.cells[0].value.value.length, 5000);
}

function testBuildSpreadsheetHyperlinkFormulaEscapesValues() {
  const context = loadCataloger();
  assert.equal(
    context.buildSpreadsheetHyperlinkFormula_(
      { getUrl: () => 'https://drive.test/file?id="one"' },
      'Folder / Bill "one".pdf'
    ),
    '=HYPERLINK("https://drive.test/file?id=""one""","Folder / Bill ""one"".pdf")'
  );
}

function testDrivePathLabelIsRelativeToConfiguredRoot() {
  const context = loadCataloger();
  context.getRootFolderId_ = () => 'root-folder';
  const iterator = (item) => {
    let consumed = false;
    return {
      hasNext: () => !consumed,
      next: () => {
        consumed = true;
        return item;
      }
    };
  };
  const root = { getId: () => 'root-folder' };
  const water = {
    getId: () => 'water-folder',
    getName: () => 'Acqua',
    getParents: () => iterator(root)
  };
  const year = {
    getId: () => 'year-folder',
    getName: () => '2026',
    getParents: () => iterator(water)
  };
  const file = {
    getName: () => 'invoice.pdf',
    getParents: () => iterator(year)
  };

  assert.equal(context.buildDrivePathLabel_(file), 'Acqua/2026/invoice.pdf');
}

function testSpreadsheetFormulaArgumentSeparatorFollowsLocale() {
  const context = loadCataloger();
  const separatorFor = (locale) => context.getSpreadsheetFormulaArgumentSeparator_({
    getParent: () => ({ getSpreadsheetLocale: () => locale })
  });
  assert.equal(separatorFor('it_IT'), ';');
  assert.equal(separatorFor('en_GB'), ',');
}

function testReferenceMonthVerificationAcceptsSheetNumericCoercion() {
  const context = loadCataloger();

  assert.equal(context.referenceMonthValuesMatch_(6, '06'), true);
  assert.equal(context.referenceMonthValuesMatch_('6', '06'), true);
  assert.equal(context.referenceMonthValuesMatch_('06', '06'), true);
  assert.equal(context.referenceMonthValuesMatch_(7, '06'), false);
  assert.equal(context.referenceMonthValuesMatch_('invoice-6', '06'), false);
}

function testFormulaTotalMustReconcileWithExtraction() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    total: ['Cost total'],
    sourceFile: ['Source file']
  })[key] || [];
  const sheet = {
    getRange: (_row, column) => ({
      getFormulas: () => [['=SUM(A1:A1)', '=HYPERLINK("url";"text")']],
      getFormula: () => column === 2 ?
        '=HYPERLINK("https://drive.test/file-id";"text")' : '=SUM(A1:A1)',
      getDisplayValue: () => column === 2 ? 'text' : '42.55',
      getValue: () => column === 1 ? 42.55 : 'text',
      getRichTextValue: () => null
    })
  };
  const extracted = validInvoice();
  extracted.sheet_values = [];

  let error = null;
  try {
    context.verifyImportedRow_(
      sheet,
      3,
      {
        headerRow: 1,
        headers: ['Cost total', 'Source file'],
        lookup: { 'cost total': 1, 'source file': 2 }
      },
      { getUrl: () => 'https://drive.test/file-id' },
      extracted
    );
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /formula total verification failed/);
  assert.deepEqual(JSON.parse(JSON.stringify(error.verificationDiscrepancies)), [{
    field: 'Cost total',
    expected: 14.64,
    actual: 42.55,
    valueType: 'money',
    tolerance: 0.02
  }]);
}

function testSupplementaryValuesCannotOverrideValidatedInvoiceTotal() {
  const context = loadCataloger();
  context.getHeaderAliases_ = (key) => ({
    total: ['Cost total'],
    sourceFile: ['Source file']
  })[key] || [];
  let actualTotal = 14.64;
  const sheet = {
    getRange: (_row, column, _rows, width) => {
      if (column === 1 && width === 2) {
        return { getFormulas: () => [['', '=HYPERLINK("url";"text")']] };
      }
      return {
        getValue: () => column === 1 ? actualTotal : 'text',
        getRichTextValue: () => null,
        getFormula: () => column === 2 ?
          '=HYPERLINK("https://drive.test/file-id";"text")' : '',
        getDisplayValue: () => 'text'
      };
    }
  };
  const extracted = validInvoice();
  extracted.sheet_values = [{ header: 'Cost total', value: 99 }];
  const layout = {
    headerRow: 1,
    headers: ['Cost total', 'Source file'],
    lookup: { 'cost total': 1, 'source file': 2 }
  };

  assert.doesNotThrow(() => context.verifyImportedRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file-id' }, extracted));
  actualTotal = 99;
  assert.throws(() => context.verifyImportedRow_(sheet, 3, layout,
    { getUrl: () => 'https://drive.test/file-id' }, extracted),
  /Spreadsheet value verification failed/);
}

function testPlainSpreadsheetValueMismatchReportsExpectedAndObservedValues() {
  const context = loadCataloger();
  vm.runInContext(
    fs.readFileSync(path.join(projectRoot, 'locales/en.gs'), 'utf8'),
    context,
    { filename: 'locales/en.gs' }
  );
  context.getLocalization_ = () => context.getEnglishLocalization_();
  context.getHeaderAliases_ = (key) => ({
    supplier: ['Supplier'],
    sourceFile: ['Source file']
  })[key] || [];
  const sheet = {
    getRange: (_row, column) => ({
      getFormulas: () => [['', '=HYPERLINK("url";"text")']],
      getFormula: () => column === 2 ?
        '=HYPERLINK("https://drive.test/file-id";"text")' : '',
      getDisplayValue: () => column === 2 ? 'text' : 'OTHER SUPPLIER',
      getValue: () => column === 1 ? 'OTHER SUPPLIER' : 'text',
      getRichTextValue: () => null
    })
  };
  const extracted = validInvoice();
  extracted.sheet_values = [];

  let error = null;
  try {
    context.verifyImportedRow_(
      sheet,
      3,
      {
        headerRow: 1,
        headers: ['Supplier', 'Source file'],
        lookup: { supplier: 1, 'source file': 2 }
      },
      { getUrl: () => 'https://drive.test/file-id' },
      extracted
    );
  } catch (caught) {
    error = caught;
  }
  assert.match(error.message, /value verification failed/);
  assert.deepEqual(JSON.parse(JSON.stringify(error.verificationDiscrepancies)), [{
    field: 'Supplier',
    expected: extracted.supplier,
    actual: 'OTHER SUPPLIER',
    valueType: 'text',
    tolerance: null
  }]);
  const report = context.formatResult_({
    status: 'ERROR',
    extracted,
    rollbackCompleted: true,
    verificationDiscrepancies: error.verificationDiscrepancies
  });
  assert.match(report,
    /Detected discrepancy: field Supplier; expected SUPPLIER; observed OTHER SUPPLIER/);
}

function testPendingReportOutboxRetriesAndRepairsMalformedEntries() {
  const context = loadCataloger();
  const prefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.PENDING_REPORT_PREFIX',
    context
  );
  const store = {
    [`${prefix}file-id`]: JSON.stringify({ body: 'report body' })
  };
  const scriptProperties = {
    getProperties: () => ({ ...store }),
    deleteProperty: (key) => {
      delete store[key];
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => scriptProperties
  };
  context.sendReportBodies_ = () => {
    throw new Error('mail unavailable');
  };

  assert.throws(() => context.flushPendingReports_(), /mail unavailable/);
  assert.equal(Object.keys(store).length, 1);

  const delivered = [];
  context.sendReportBodies_ = (bodies) => delivered.push(...bodies);
  assert.equal(context.flushPendingReports_().sent, 1);
  assert.deepEqual(delivered, ['report body']);
  assert.equal(Object.keys(store).length, 0);

  store[`${prefix}broken-id`] = '{';
  assert.equal(context.flushPendingReports_().sent, 1);
  assert.match(delivered[1], /could not be decoded/);
  assert.match(delivered[1], /broken-id/);
  assert.equal(Object.keys(store).length, 0);
}

function testPendingReportOutboxFlushesBeforeItsStorageBudget() {
  const context = loadCataloger();
  const prefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.PENDING_REPORT_PREFIX',
    context
  );
  const store = {};
  for (let index = 0; index < 35; index += 1) {
    store[`${prefix}existing-${index}`] = JSON.stringify({
      body: 'x'.repeat(7000)
    });
  }
  const scriptProperties = {
    getProperties: () => ({ ...store }),
    setProperty: (key, value) => {
      store[key] = value;
    },
    setProperties: (values) => {
      Object.assign(store, values);
    }
  };
  context.PropertiesService = {
    getScriptProperties: () => scriptProperties
  };
  context.formatResult_ = (_result, includeExtractionSnapshot) => {
    assert.equal(includeExtractionSnapshot, false);
    return 'new report';
  };
  let flushes = 0;
  context.flushPendingReports_ = () => {
    flushes += 1;
    Object.keys(store).forEach((key) => {
      if (key.startsWith(prefix)) {
        delete store[key];
      }
    });
    return { sent: 40 };
  };

  context.queuePendingReports_([{
    status: 'ERROR',
    fileUrl: 'https://drive.test/abcdefghijklmnopqrstuvwxyz123456',
    extracted: {
      ...validInvoice(),
      sheet_values: [{ value: 'x'.repeat(20000) }]
    }
  }]);

  assert.equal(flushes, 1);
  assert.ok(Object.values(store).some((value) => /new report/.test(value)));
}

function testPendingReportOutboxChunksLargeExtractionSnapshots() {
  const context = loadCataloger();
  context.getLocalization_ = () => context.getEnglishLocalization_();
  const reportPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.PENDING_REPORT_PREFIX', context
  );
  const snapshotPrefix = vm.runInContext(
    'CONFIG.PROPERTY_KEYS.PENDING_REPORT_SNAPSHOT_PREFIX', context
  );
  const correlationId = 'abcdefghijklmnopqrstuvwxyz123456';
  const extraction = {
    ...validInvoice(),
    consumption_description: 'x'.repeat(20000),
    sheet_values: [{
      header: 'Detailed reading',
      value: 'x'.repeat(9000)
    }]
  };
  const snapshot = JSON.stringify(extraction);
  assert.ok(Buffer.byteLength(snapshot, 'utf8') > 8000);
  const { store } = installScriptPropertyStore(context);

  context.queuePendingReports_([{
    status: 'ERROR',
    fileUrl: 'https://drive.test/' + correlationId,
    originalName: 'invoice.pdf',
    extracted: extraction,
    rollbackCompleted: true,
    actions: 'Automatic rollback completed.',
    problem: 'Spreadsheet verification failed.',
    recommendedAction: 'Review the recovered PDF, then retry the import.',
    supplierProfilesUrl: 'https://drive.test/supplier-profiles',
    retryUrl: 'https://script.test/retry'
  }]);

  const queued = JSON.parse(store[`${reportPrefix}${correlationId}`]);
  assert.equal(queued.body.includes(snapshot), false);
  assert.ok(Buffer.byteLength(queued.body, 'utf8') < 8000);
  assert.match(queued.body, /Field truncated; inspect the source PDF/);
  assert.match(queued.body, /Actions taken: Automatic rollback completed/);
  assert.match(queued.body, /Review the recovered PDF, then retry the import/);
  assert.match(queued.body, /Supplier profiles and proposals: https:\/\/drive\.test\/supplier-profiles/);
  assert.match(queued.body, /Retry import: https:\/\/script\.test\/retry/);
  assert.ok(queued.extractionSnapshotChunks > 1);
  const storedSnapshot = Array.from({ length: queued.extractionSnapshotChunks },
    (_, index) => store[`${snapshotPrefix}${correlationId}_` +
      `${queued.extractionSnapshotId}_${index}`]
  ).join('');
  assert.equal(storedSnapshot, snapshot);

  context.sendReportBodies_ = () => {
    throw new Error('mail unavailable');
  };
  assert.throws(() => context.flushPendingReports_(), /mail unavailable/);
  assert.ok(store[`${reportPrefix}${correlationId}`]);
  assert.ok(Object.keys(store).some((key) => key.startsWith(snapshotPrefix)));

  const delivered = [];
  context.sendReportBodies_ = (bodies) => delivered.push(...bodies);
  assert.equal(context.flushPendingReports_().sent, 1);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /Actions taken: Automatic rollback completed/);
  assert.match(delivered[0], /Retry import: https:\/\/script\.test\/retry/);
  assert.ok(delivered[0].endsWith('Extracted snapshot: ' + snapshot));
  assert.equal(Object.keys(store).filter((key) =>
    key.startsWith(reportPrefix) || key.startsWith(snapshotPrefix)
  ).length, 0);
}

function testPendingReportTruncationPreservesOperatorSection() {
  const context = loadCataloger();
  context.getLocalization_ = () => context.getEnglishLocalization_();
  const operatorSection = [
    'Actions taken: Automatic rollback completed.',
    'Issue and recommended action: Review the recovered PDF.',
    'Supplier profiles and proposals: https://drive.test/supplier-profiles',
    'Retry import: https://script.test/retry'
  ].join('\n');
  const body = 'Consumption or contributions: ' + 'x'.repeat(20000) +
    '\n' + operatorSection;

  const truncated = context.truncatePendingReportBody_(body);

  assert.ok(Buffer.byteLength(JSON.stringify({ body: truncated }), 'utf8') <= 8000);
  assert.match(truncated, /Report truncated; inspect the source PDF/);
  assert.ok(truncated.endsWith(operatorSection));
}

function testLockAndLogContracts() {
  let callbackRan = false;
  const context = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: () => '' })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => false,
        releaseLock: () => {
          throw new Error('must not release an unowned lock');
        }
      })
    }
  });
  context.logCatalogEvent_ = () => {};
  const result = context.withCatalogProcessingLock_('test', () => {
    callbackRan = true;
  });

  assert.equal(callbackRan, false);
  assert.equal(result.skipped, 'already-running');

  context.PropertiesService = {
    getScriptProperties: () => ({ getProperty: () => 'transaction-1' })
  };
  const maintenanceResult = context.withCatalogProcessingLock_(
    'test',
    () => { callbackRan = true; }
  );
  assert.equal(maintenanceResult.skipped, 'maintenance');
  assert.equal(callbackRan, false);

  let maintenanceReads = 0;
  let releasedAfterMaintenance = false;
  const racedContext = loadCataloger({
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: () => {
          maintenanceReads += 1;
          return maintenanceReads > 1 ? 'transaction-1' : '';
        }
      })
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => { releasedAfterMaintenance = true; }
      })
    }
  });
  racedContext.logCatalogEvent_ = () => {};
  const racedResult = racedContext.withCatalogProcessingLock_(
    'test',
    () => { callbackRan = true; }
  );
  assert.equal(racedResult.skipped, 'maintenance');
  assert.equal(releasedAfterMaintenance, true);
  assert.equal(callbackRan, false);
  assert.deepEqual(
    Object.keys(context.describeFileForLog_({ getId: () => 'file-id' })),
    ['fileId']
  );
}

function testProcessingLeaseAndDocumentStatus() {
  const context = loadCataloger();
  const file = {
    getId: () => 'file-id',
    getLastUpdated: () => new Date(0),
    getSize: () => 10
  };
  const state = {};
  context.markIntakeFileProcessing_(state, file);
  assert.equal(state['file-id'].status, 'PROCESSING');

  const report = validInvoice();
  report.document_type = 'Report';
  const result = context.buildSuccessResult_(
    { getUrl: () => 'https://drive.test/file-id' },
    'old.pdf',
    'new.pdf',
    { path: 'Reports' },
    report,
    ''
  );
  assert.equal(result.status, 'ARCHIVED WITHOUT IMPORT');
}

function testManualRetryProcessesSameDayErrorsOnly() {
  const context = loadCataloger();
  const file = {
    getId: () => 'file-id',
    getLastUpdated: () => new Date(0),
    getSize: () => 10
  };
  context.hasMutationJournal_ = () => false;
  context.intakeStateDate_ = () => '2026-07-17';
  const state = {
    'file-id': {
      fingerprint: '0:10',
      status: 'ERROR',
      attemptDate: '2026-07-17'
    }
  };

  assert.equal(context.shouldProcessIntakeFile_(file, state, 'daily'), false);
  assert.equal(context.shouldProcessIntakeFile_(file, state, 'manual_retry'), true);
  state['file-id'].status = 'NEEDS REVIEW';
  assert.equal(context.shouldProcessIntakeFile_(file, state, 'manual_retry'), false);
}

function testSingleFilePreflightsTargetBeforeGlobalSideEffects() {
  const file = { getId: () => 'file-id' };
  const rootFolder = {};
  const calls = [];
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder,
      getFileById: (fileId) => {
        calls.push('get-file:' + fileId);
        return file;
      }
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => calls.push('release-lock')
      })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.logCatalogEvent_ = () => {};
  context.hasMutationJournal_ = () => false;
  context.isDirectIntakePdf_ = () => false;
  context.flushPendingReports_ = () => calls.push('flush');

  assert.throws(
    () => context.processSingleIntakeFile('file-id'),
    /not a PDF located directly in the intake folder/
  );
  assert.deepEqual(calls, ['get-file:file-id', 'release-lock']);
}

function testSingleFileByNameResolvesExactlyOneDirectIntakePdf() {
  const file = {
    getId: () => 'file-id',
    getName: () => 'synthetic-invoice.pdf',
    getMimeType: () => 'application/pdf',
    isTrashed: () => false,
    getParents: () => ({
      hasNext: () => true,
      next: () => rootFolder
    })
  };
  const ignoredFile = {
    getId: () => 'ignored-file-id',
    getName: () => 'synthetic-invoice.pdf',
    getMimeType: () => 'text/plain',
    isTrashed: () => false,
    getParents: () => ({
      hasNext: () => true,
      next: () => rootFolder
    })
  };
  const rootFolder = { getId: () => 'root-folder-id' };
  const calls = [];
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {}
      })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.isCatalogMaintenanceActive_ = () => false;
  context.logCatalogEvent_ = () => {};
  context.processSingleIntakeFileWithinLock_ = (fileId, deadlineAt) => {
    calls.push(fileId);
    assert.ok(deadlineAt > Date.now());
    return { status: 'IMPORTED' };
  };
  const files = [ignoredFile, file];
  let index = 0;
  rootFolder.getFilesByName = (name) => {
    assert.equal(name, ' synthetic-invoice.pdf ');
    return {
      hasNext: () => index < files.length,
      next: () => files[index++]
    };
  };

  assert.deepEqual(
    context.processSingleIntakeFileByName(' synthetic-invoice.pdf '),
    { status: 'IMPORTED' }
  );
  assert.deepEqual(calls, ['file-id']);
}

function testSingleFileByNameRejectsMissingOrAmbiguousMatches() {
  const rootFolder = {};
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {}
      })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.isDirectIntakePdf_ = () => true;
  context.isCatalogMaintenanceActive_ = () => false;
  context.logCatalogEvent_ = () => {};

  assert.throws(
    () => context.processSingleIntakeFileByName('  '),
    /exact intake PDF filename is required/
  );

  rootFolder.getFilesByName = () => ({
    hasNext: () => false,
    next: () => { throw new Error('unexpected next'); }
  });
  assert.throws(
    () => context.processSingleIntakeFileByName('missing.pdf'),
    /No matching PDF/
  );

  const files = [
    { getId: () => 'file-one' },
    { getId: () => 'file-two' }
  ];
  let index = 0;
  rootFolder.getFilesByName = () => ({
    hasNext: () => index < files.length,
    next: () => files[index++]
  });
  assert.throws(
    () => context.processSingleIntakeFileByName('duplicate.pdf'),
    /Multiple matching PDFs/
  );
}

function testSingleFileProcessesOnlyTheValidatedTarget() {
  const file = { getId: () => 'file-id' };
  const rootFolder = {};
  const result = { status: 'IMPORTED' };
  const calls = [];
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder,
      getFileById: () => file
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {}
      })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.logCatalogEvent_ = () => {};
  context.logCatalogResult_ = () => {};
  context.hasMutationJournal_ = () => false;
  context.isDirectIntakePdf_ = () => true;
  context.flushPendingReports_ = () => calls.push('flush');
  context.listDirectIntakePdfs_ = () => {
    throw new Error('single-file processing must not scan intake');
  };
  context.loadDriveAgentsPolicy_ = () => 'policy';
  context.loadIntakeFileState_ = () => ({});
  context.markIntakeFileProcessing_ = () => {};
  context.saveIntakeFileState_ = () => {};
  context.processIntakeFile_ = (candidate) => {
    assert.equal(candidate, file);
    calls.push('process');
    return result;
  };
  context.persistCatalogResult_ = () => {};
  context.finalizeCatalogResults_ = () => {};

  assert.equal(context.processSingleIntakeFile('file-id'), result);
  assert.deepEqual(calls, ['flush', 'process']);
}

function testSingleFilePersistsWhenOperatorLinksFail() {
  const file = { getId: () => 'file-id' };
  const rootFolder = {};
  const result = { status: 'IMPORTED' };
  const calls = [];
  const linkFailureEvents = [];
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder,
      getFileById: () => file
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.logCatalogEvent_ = (event, details) => {
    if (event === 'catalog-operator-links-failed') {
      linkFailureEvents.push(details);
    }
  };
  context.describeFileForLog_ = () => ({ fileId: 'file-id' });
  context.logCatalogResult_ = (candidate, actual) => {
    assert.equal(candidate, file);
    assert.equal(actual, result);
    calls.push('log-result');
  };
  context.hasMutationJournal_ = () => false;
  context.isDirectIntakePdf_ = () => true;
  context.flushPendingReports_ = () => calls.push('flush');
  context.loadDriveAgentsPolicy_ = () => 'policy';
  context.loadIntakeFileState_ = () => ({ state: 'initial' });
  context.markIntakeFileProcessing_ = () => {};
  context.saveIntakeFileState_ = () => {};
  context.processIntakeFile_ = () => {
    calls.push('process');
    return result;
  };
  context.addOperatorLinksToResult_ = () => {
    calls.push('links');
    throw new Error('profile lookup unavailable');
  };
  context.persistCatalogResult_ = (_state, candidate, folder, actual) => {
    assert.equal(candidate, file);
    assert.equal(folder, rootFolder);
    assert.equal(actual, result);
    calls.push('persist');
  };
  context.finalizeCatalogResults_ = (_state, results) => {
    assert.equal(results.length, 1);
    assert.equal(results[0], result);
    calls.push('finalize');
  };

  assert.equal(context.processSingleIntakeFile('file-id'), result);
  assert.deepEqual(calls, [
    'flush', 'process', 'links', 'persist', 'log-result', 'finalize'
  ]);
  assert.equal(linkFailureEvents.length, 1);
  assert.equal(linkFailureEvents[0].fileId, 'file-id');
  assert.equal(linkFailureEvents[0].reason, 'profile lookup unavailable');
}

function testSingleFileRecoversOnlyTargetJournal() {
  const file = { getId: () => 'file-id' };
  const rootFolder = {};
  const calls = [];
  let hasJournal = true;
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => rootFolder,
      getFileById: () => file
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.hasMutationJournal_ = () => hasJournal;
  context.recoverMutationJournalForFile_ = (folder, fileId) => {
    assert.equal(folder, rootFolder);
    assert.equal(fileId, 'file-id');
    calls.push('recover:file-id');
    hasJournal = false;
  };
  context.isDirectIntakePdf_ = () => true;
  context.flushPendingReports_ = () => {};
  context.loadDriveAgentsPolicy_ = () => 'policy';
  context.logCatalogEvent_ = () => {};
  context.logCatalogResult_ = () => {};
  context.loadIntakeFileState_ = () => ({});
  context.markIntakeFileProcessing_ = () => {};
  context.saveIntakeFileState_ = () => {};
  context.processIntakeFile_ = () => ({ status: 'IMPORTED' });
  context.persistCatalogResult_ = () => {};
  context.finalizeCatalogResults_ = () => {};

  context.processSingleIntakeFile('file-id');
  assert.deepEqual(calls, ['recover:file-id']);
}

function testSingleFileStopsWhenTargetJournalRemains() {
  const calls = [];
  const context = loadCataloger({
    DriveApp: {
      getFolderById: () => ({}),
      getFileById: () => {
        calls.push('get-file');
        throw new Error('unavailable');
      }
    },
    LockService: {
      getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} })
    }
  });
  context.assertCatalogConfiguration_ = () => {};
  context.getRootFolderId_ = () => 'root-folder-id';
  context.logCatalogEvent_ = () => {};
  context.hasMutationJournal_ = () => true;
  context.recoverMutationJournalForFile_ = () => calls.push('recover');

  assert.throws(
    () => context.processSingleIntakeFile('file-id'),
    /unresolved mutation journal/
  );
  assert.deepEqual(calls, ['recover']);
}

testFormulaLikeTextIsWrittenLiterally();
testManagedSupplierProfileWorkspaceIdentityIsRequired();
testSupplierProfilesAreOmittedWithoutWorkspaceState();
testSupplierProfilesSkipStateLookupForMinimalRootAdapter();
testSupplierProfileWorkspaceRejectsIncompleteState();
testSupplierProfileWorkspaceRejectsSameNamedReplacement();
testSupplierProfileWorkspaceRejectsUnavailableRecordedRoot();
testSupplierProfileContextLimitIncludesRenderedMetadata();
testSupplierProfilesRejectDuplicateMetadataSuppliersAcrossFolders();
testExtractionSchemaAndCalendarValidation();
testServiceIdentityMatchesNormalizedHolderAndAddress();
testFirstInvoiceCanEstablishMissingServiceIdentity();
testFirstInvoiceRequiresManagedServiceIdentityMetadata();
testFirstInvoiceCannotReplaceFormulaBackedIdentityControls();
testLegacyHeaderRowWithoutControlsRemainsFailClosed();
testInvoiceFrequencyInferenceUsesPeriodAndHistory();
testResolvedFrequencyReconcilesOnlyStaleMissingDiagnostics();
testConfiguredSecondaryAbsenceRequiresStructuredEligibilityAndReconciliation();
testFrequencySentinelsRemainUnresolvedUntilCadenceIsUsable();
testServiceIdentityAcceptsComponentAndEvidencePermutations();
testServiceIdentityRejectsExtractedStreetPrefix();
testServiceIdentityRejectsExtractedComponentSuffix();
testServiceIdentityRejectsWrongAddressAndMissingBaseline();
testServiceIdentityRejectsCityMatchedByStreetTokens();
testServiceIdentityRejectsOverlappingRepeatedEvidenceComponents();
testServiceIdentityRejectsUncorroboratedAddressEvidence();
testServiceIdentityRejectsCivicNumberAmbiguity();
testServiceIdentityRejectsMissingAddressComponents();
testEnglishLocaleAcceptsItalianOptionalCustomerNumberProblem();
testSupplierDefaultsUseRuntimeTargetHeaders();
testPendingDashboardRefreshRetriesWithoutProcessingPdfs();
testScheduledCatalogRunRetriesDashboardBeforeScanning();
testExtractionInfersMissingFrequencyBeforeValidation();
testExtractionRepairLoopUsesStructuredFeedbackAndStopsWhenValid();
testValidationPipelinePreservesBootstrapEligibility();
testExtractionRepairLoopUsesAtMostThreeAiCallsWithHistory();
testExtractionRepairLoopDoesNotRetryNonRepairableState();
testExtractionRepairLoopRetriesInvalidStructuredOutput();
testExtractionRepairLoopDefersWhenSharedRuntimeBudgetIsLow();
testExtractionRepairLoopPreservesNormalizationSnapshot();
testExtractionRepairLoopPreservesLastValidExtractionAfterMalformedRepair();
testGeminiEmptyStopResponseIsRepairableOutput();
testExtractionRepairLoopExhaustsMalformedOutputs();
testExtractionRepairLoopTracksChangingFeedback();
testModelNormalizationFailureIsRepairable();
testExtractionValidationPipelineStopsAtTheFailingBoundary();
testExhaustedExtractionRepairDoesNotStartMutations();
testExtractionRepairPromptRequiresCompleteReplacementWithMemory();
testSupplierDefaultsNormalizeConfiguredIdentities();
testAmbiguousAddressRulesFailClosed();
testHiddenPdfsAreExcludedFromIntake();
testDeveloperApiKeyUsesHeader();
testConfigureGeminiModelUpdatesTheSharedRuntimeModel();
testVertexCostEstimateDoesNotReusePricingForGemini37();
testIncompleteGeminiResponseReportsFinishReason();
testGeminiResponseWithoutFinishReasonFailsClosed();
testDepletedPrepaymentCreditsSwitchToVertexForOneHour();
testRepairContextSurvivesAutomaticVertexFallback();
testEmailReportIncludesSoftwareVersion();
testPostExtractionSpreadsheetErrorReportPreservesDiagnostics();
testFailedFirstImportRestoresServiceIdentityControls();
testPreExtractionErrorReportKeepsDataUnavailable();
testErrorResultMarksRetainedDestinationFoldersAsIncomplete();
testDestinationFolderCreationCheckpointsEachCreatedPath();
testGenericRateLimitStaysOnDeveloperApi();
testVertexRateLimitRetriesWithoutReclassifyingProviderQuota();
testStructuredFileLogsContainOnlyOpaqueId();
testReportFieldsCannotInjectExtraLines();
testDashboardRefreshWarningIsReported();
testPromptKeepsHeadersScopedBySupply();
testHeadersAreCollectedPerSupply();
testDuplicateNormalizedSheetHeadersAreRejected();
testSheetLayoutAcceptsPendingLocaleAliases();
testSheetLayoutAcceptsInstallerControlRowShiftAtBoundary();
testSheetLayoutAcceptsHeaderAtRowTen();
testMutationRecoveryStages();
testMutationJournalCapturesValidatedReportingContextBeforeMutations();
testMutationJournalPersistsFailureStageAtProcessingCheckpoints();
testMutationJournalChunksLargeValidatedExtractionSnapshots();
testMutationRecoveryPersistsDeletedRowWithFallbackCheckpoint();
testMutationRecoveryRestoresInitialServiceIdentity();
testMutationRecoveryReportsUnavailableFileOnce();
testRuntimeExhaustionPersistsOperatorLinks();
testTargetMutationJournalRecoveryLeavesUnrelatedJournalUntouched();
testRecoveryMarksUnmarkedRowsAsIncomplete();
testAccessibleRecoveryFailureRequiresManualReview();
testFormulaAndStyleCopySources();
testExistingFormulaCellsAreNotOverwrittenDuringReimport();
testDetailedCostSheetValuesOverrideBroadReconciliationValues();
testSupplementarySheetValuesCannotOverrideLiteralCanonicalFields();
testVerifyImportedRowKeepsExtractedIdentityAgainstSheetValues();
testMissingRowFormulaDoesNotUnprotectTemplateColumn();
testSourceHyperlinkFormulaIsPreserved();
testExistingInvoicePayloadRestoresAndRepositions();
testExistingInvoiceRollbackRestoresNumberFormatAfterFailedReplacement();
testFirstInvoiceImportEstablishesServiceIdentityControls();
testCorrectedInvoiceMovesImmediatelyBeforeNewerInvoice();
testCorrectedInvoiceAppendsWithoutBlankRow();
testInsertedInvoiceDeleteFailureBeforeMarkerPreservesJournalState();
testInsertedInvoiceDeleteFailureAfterMarkerPreservesJournalState();
testExpectedBootstrapChangeAbortsBeforeRowInsertion();
testExpectedBootstrapChangeAbortsBeforeExistingRowReplacement();
testBootstrapBoundaryRejectsNewRowsBeforeInsertion();
testInsertedInvoiceRetainsRowWhenDashboardRefreshWarns();
testDashboardRollbackForcesRegeneration();
testRowDeletionIsJournaledBeforeDashboardRollback();
testOuterRollbackUsesFullJournalFallbackCheckpoint();
testOuterRollbackDoesNotCheckpointMissingRowLocation();
testMutationJournalPayloadUsesSeparateChunks();
testBuildSpreadsheetHyperlinkFormulaEscapesValues();
testDrivePathLabelIsRelativeToConfiguredRoot();
testSpreadsheetFormulaArgumentSeparatorFollowsLocale();
testReferenceMonthVerificationAcceptsSheetNumericCoercion();
testFormulaTotalMustReconcileWithExtraction();
testSupplementaryValuesCannotOverrideValidatedInvoiceTotal();
testPlainSpreadsheetValueMismatchReportsExpectedAndObservedValues();
testPendingReportOutboxRetriesAndRepairsMalformedEntries();
testPendingReportOutboxFlushesBeforeItsStorageBudget();
testPendingReportOutboxChunksLargeExtractionSnapshots();
testPendingReportTruncationPreservesOperatorSection();
testLockAndLogContracts();
testProcessingLeaseAndDocumentStatus();
testManualRetryProcessesSameDayErrorsOnly();
testSingleFilePreflightsTargetBeforeGlobalSideEffects();
testSingleFileByNameResolvesExactlyOneDirectIntakePdf();
testSingleFileByNameRejectsMissingOrAmbiguousMatches();
testSingleFileProcessesOnlyTheValidatedTarget();
testSingleFilePersistsWhenOperatorLinksFail();
testSingleFileRecoversOnlyTargetJournal();
testSingleFileStopsWhenTargetJournalRemains();

console.log('Utilities cataloging tests passed.');
