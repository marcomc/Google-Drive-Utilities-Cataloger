/** Approved profile data supplies document knowledge; this module only validates it. */
function configureApprovedProfileWorkspace(options) {
  assertCatalogConfiguration_();
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
    Object.keys(options).some(function (key) {
      return ['rootFolderId', 'profileRootId', 'templateFolderId'].indexOf(key) < 0;
    }) || ['rootFolderId', 'profileRootId', 'templateFolderId'].some(function (key) {
      return typeof options[key] !== 'string' || !/^[A-Za-z0-9_-]+$/.test(options[key]);
    }) || options.rootFolderId !== getRootFolderId_()) {
    throw new Error('Profile workspace identities must match the installed intake folder.');
  }
  return withCatalogLifecycleLock_('profile-workspace-configuration', function () {
    return withCatalogProcessingLock_('profile-workspace-configuration', function () {
      const prior = loadSupplierProfileWorkspaceStateForExtraction_();
      if (prior && ['rootFolderId', 'profileRootId', 'templateFolderId'].some(function (key) {
        return prior[key] !== options[key];
      })) { throw new Error('An existing profile workspace has different resource identities.'); }
      const names = getSupplierProfileNames_();
      const root = DriveApp.getFolderById(options.rootFolderId);
      const child = function (parent, name, expectedId) {
        const found = parent.getFoldersByName(name);
        if (!found.hasNext()) { throw new Error('The selected profile workspace folder is missing.'); }
        const folder = found.next();
        if (found.hasNext() || folder.isTrashed() || folder.getId() !== expectedId || folder.getName() !== name) {
          throw new Error('The selected profile workspace identity is ambiguous or mismatched.');
        }
        return folder;
      };
      const profileRoot = child(root, names.folder, options.profileRootId);
      child(profileRoot, names.templateFolder, options.templateFolderId);
      readApprovedProfilesFromRoot_(profileRoot, names);
      const state = Object.assign({}, prior || {}, {
        rootFolderId: options.rootFolderId,
        profileRootParentId: options.rootFolderId, profileRootName: names.folder,
        profileRootStatus: 'managed', profileRootId: options.profileRootId,
        templateFolderParentId: options.profileRootId, templateFolderName: names.templateFolder,
        templateFolderStatus: 'managed', templateFolderId: options.templateFolderId
      });
      const properties = PropertiesService.getScriptProperties();
      const serialized = JSON.stringify(state);
      if (properties.getProperty(CONFIG.PROPERTY_KEYS.SUPPLIER_PROFILE_WORKSPACE_STATE) === serialized) {
        return { configured: true, applicationVersion: CONFIG.APP_VERSION, changed: false };
      }
      properties.setProperty(CONFIG.PROPERTY_KEYS.SUPPLIER_PROFILE_WORKSPACE_STATE, serialized);
      if (properties.getProperty(CONFIG.PROPERTY_KEYS.SUPPLIER_PROFILE_WORKSPACE_STATE) !== serialized) {
        throw new Error('Profile workspace configuration read-back failed.');
      }
      return { configured: true, applicationVersion: CONFIG.APP_VERSION, changed: true };
    });
  });
}

function validateApprovedInvoiceProfiles() {
  assertCatalogConfiguration_();
  return withCatalogProcessingLock_('profile-validation', function () {
    const state = loadSupplierProfileWorkspaceStateForExtraction_();
    if (!state) { return { applicationVersion: CONFIG.APP_VERSION, configured: false, profiles: [] }; }
    const root = DriveApp.getFolderById(getRootFolderId_());
    const text = loadApprovedSupplierProfiles_(root);
    const names = getSupplierProfileNames_();
    const profiles = Array.from(text.matchAll(
      /--- BEGIN APPROVED SUPPLIER PROFILE: [^\n]+ ---\n([\s\S]*?)\n--- END APPROVED SUPPLIER PROFILE ---/g))
      .map(function (block) {
        const metadata = parseApprovedSupplierProfileMetadata_(block[1], names);
        const contract = parseInvoiceContract_(block[1]);
        return { supplier: metadata[names.supplierKey],
          supplies: getApprovedProfileScopes_(metadata, names, contract),
          hasInvoiceContract: Boolean(contract) };
      });
    return { applicationVersion: CONFIG.APP_VERSION, configured: true, profiles: profiles };
  });
}

function isInvoiceContractWritableMoneyHeader_(header) {
  if (!isNumericInvoiceHeader_(header) || isConsumptionQuantityHeader_(header) || isUnitCostHeader_(header)) {
    return false;
  }
  const registry = getLocalizationRegistry_();
  const immutable = Object.keys(registry).reduce(function (all, locale) {
    return all.concat(registry[locale].headerAliases.vat, registry[locale].headerAliases.total);
  }, []).map(normalizeHeader_);
  return immutable.indexOf(normalizeHeader_(header)) < 0;
}

function parseInvoiceContract_(text) {
  const blocks = Array.from(String(text || '').matchAll(/```invoice-contract\s*\n([\s\S]*?)\n```/g));
  if (!blocks.length) { return null; }
  if (blocks.length !== 1) { throw new Error('An approved profile must contain at most one invoice contract.'); }
  let contract;
  try { contract = JSON.parse(blocks[0][1]); } catch (error) {
    throw new Error('Approved invoice contract is not valid JSON.');
  }
  const object = function (value) { return value && typeof value === 'object' && !Array.isArray(value); };
  const keys = function (value, allowed) {
    return object(value) && Object.keys(value).every(function (key) { return allowed.indexOf(key) >= 0; });
  };
  const strings = function (value, max) {
    return Array.isArray(value) && value.length <= max && value.every(function (item) {
      return typeof item === 'string' && item.length > 0 && item.length <= 200;
    }) && new Set(value).size === value.length;
  };
  const list = function (value) { return value === undefined ? [] : value; };
  const invalid = function () { throw new Error('Approved invoice contract is malformed or unsupported.'); };
  if (!keys(contract, ['version', 'supplies', 'components', 'checks', 'allocations',
    'defaults', 'products', 'electricity_consumption', 'customer_code_prefixes', 'identifier_absence_statements']) ||
    contract.version !== 1 || !strings(contract.supplies, 20) || !contract.supplies.length ||
    typeof contract.electricity_consumption !== 'undefined' && typeof contract.electricity_consumption !== 'boolean') {
    invalid();
  }
  ['components', 'checks', 'allocations', 'defaults', 'products'].forEach(function (key) {
    contract[key] = list(contract[key]);
    if (!Array.isArray(contract[key]) || contract[key].length > 100) { invalid(); }
  });
  const ids = Object.create(null);
  contract.components.forEach(function (component) {
    if (!keys(component, ['id', 'absence_value', 'absence_statements', 'reference_only']) ||
      typeof component.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(component.id) || ids[component.id] ||
      component.absence_value !== undefined && (typeof component.absence_value !== 'number' || !Number.isFinite(component.absence_value) ||
        !strings(component.absence_statements, 20) || !component.absence_statements.length) ||
      component.absence_statements !== undefined && component.absence_value === undefined ||
      component.reference_only !== undefined && typeof component.reference_only !== 'boolean') { invalid(); }
    ids[component.id] = component;
  });
  const reference = function (value) {
    return typeof value === 'string' && (Boolean(ids[value]) ||
      /^field:(?:cost_consumption|cost_non_consumption|vat|total)$/.test(value) ||
      /^header:.{1,200}$/.test(value));
  };
  contract.checks.forEach(function (check) {
    if (!keys(check, ['total', 'parts']) || !reference(check.total) ||
      !strings(check.parts, 100) || !check.parts.length || !check.parts.every(reference) ||
      check.parts.indexOf(check.total) >= 0) { invalid(); }
  });
  contract.products.forEach(function (check) {
    if (!keys(check, ['quantity_header', 'rate_header', 'total']) ||
      typeof check.quantity_header !== 'string' || !check.quantity_header || check.quantity_header.length > 200 ||
      typeof check.rate_header !== 'string' || !check.rate_header || check.rate_header.length > 200 ||
      !isConsumptionQuantityHeader_(check.quantity_header) || !isUnitCostHeader_(check.rate_header) ||
      !reference(check.total)) { invalid(); }
  });
  const targets = Object.create(null);
  contract.allocations.forEach(function (allocation) {
    const targetKey = typeof allocation.target === 'string' && allocation.target.indexOf('header:') === 0 ?
      'header:' + normalizeHeader_(allocation.target.slice(7)) : allocation.target;
    if (!keys(allocation, ['target', 'parts', 'group', 'replace_from']) ||
      typeof allocation.target !== 'string' ||
      !/^(?:field:cost_consumption|field:cost_non_consumption|header:.{1,200})$/.test(allocation.target) ||
      allocation.target.indexOf('header:') === 0 && !isInvoiceContractWritableMoneyHeader_(allocation.target.slice(7)) ||
      targets[targetKey] || !strings(allocation.parts, 100) || !allocation.parts.length ||
      !allocation.parts.every(function (id) { return ids[id] && !ids[id].reference_only; }) ||
      typeof allocation.group !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(allocation.group) ||
      allocation.replace_from !== undefined && (!strings(allocation.replace_from, 100) ||
        !allocation.replace_from.every(function (id) { return Boolean(ids[id]); }))) { invalid(); }
    targets[targetKey] = true;
  });
  const children = Object.create(null);
  contract.checks.forEach(function (check) {
    if (ids[check.total] && check.parts.every(function (part) { return Boolean(ids[part]); })) {
      if (children[check.total]) { invalid(); }
      children[check.total] = check.parts;
    }
  });
  const leaves = function (id, ancestors) {
    if (ancestors.indexOf(id) >= 0) { invalid(); }
    if (!children[id]) { return [id]; }
    const result = [];
    children[id].forEach(function (child) {
      leaves(child, ancestors.concat(id)).forEach(function (leaf) {
        if (result.indexOf(leaf) >= 0 || result.length >= 100) { invalid(); }
        result.push(leaf);
      });
    });
    return result;
  };
  Object.keys(children).forEach(function (id) {
    const entries = leaves(id, []);
    if (new Set(entries).size !== entries.length) { invalid(); }
  });
  const allocated = Object.create(null);
  contract.allocations.forEach(function (allocation) {
    const used = allocated[allocation.group] || (allocated[allocation.group] = Object.create(null));
    allocation.parts.forEach(function (id) {
      leaves(id, []).forEach(function (leaf) {
        if (used[leaf]) { invalid(); }
        used[leaf] = true;
      });
    });
  });
  const defaultHeaders = Object.create(null);
  contract.defaults.forEach(function (rule) {
    const identity = typeof rule.header === 'string' ? normalizeHeader_(rule.header) : '';
    if (defaultHeaders[identity] || !keys(rule, ['header', 'value', 'aliases', 'absence_statements']) || typeof rule.header !== 'string' ||
      !rule.header || rule.header.length > 200 || !isInvoiceContractWritableMoneyHeader_(rule.header) || typeof rule.value !== 'number' || !Number.isFinite(rule.value) ||
      rule.aliases !== undefined && !strings(rule.aliases, 20) ||
      rule.absence_statements !== undefined && !strings(rule.absence_statements, 20)) { invalid(); }
    defaultHeaders[identity] = true;
  });
  ['customer_code_prefixes', 'identifier_absence_statements'].forEach(function (key) {
    contract[key] = list(contract[key]);
    if (!strings(contract[key], 20)) { invalid(); }
  });
  return contract;
}

function getApprovedInvoiceContract_(policy, extracted) {
  if (!extracted || extracted.document_type !== 'Invoice') { return null; }
  const blocks = Array.from(String(policy || '').matchAll(
    /--- BEGIN APPROVED SUPPLIER PROFILE: [^\n]+ ---\n([\s\S]*?)\n--- END APPROVED SUPPLIER PROFILE ---/g));
  const matches = [];
  const names = getSupplierProfileNames_();
  blocks.forEach(function (block) {
    const metadata = parseApprovedSupplierProfileMetadata_(block[1], names);
    if (!metadata) { throw new Error('Approved profile metadata is invalid.'); }
    const contract = parseInvoiceContract_(block[1]);
    getApprovedProfileScopes_(metadata, names, contract);
    if (contract && supplierIdentitiesMatch_(metadata[names.supplierKey], extracted.supplier,
      getAutomationConfig_()) && contract.supplies.some(function (supply) {
      return normalizeSupplyType_(supply) === extracted.supply_type;
    })) { matches.push(contract); }
  });
  if (matches.length > 1) { throw new Error('More than one approved invoice contract matches this invoice.'); }
  return matches[0] || null;
}

function getApprovedProfileScopes_(metadata, names, contract) {
  const raw = metadata[names.suppliesKey || 'supplies'];
  let scopes;
  if (raw === undefined) {
    scopes = contract ? contract.supplies : ['*'];
  } else {
    const list = /^\[([^\[\]\r\n]*)\]$/.exec(raw);
    if (!list) { throw new Error('Approved profile supplies must be a bounded list.'); }
    scopes = list[1].split(',').map(function (item) {
      const value = item.trim();
      return /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
    });
    if (!scopes.length || scopes.length > 20 || scopes.some(function (item) {
      return !item || item.length > 200;
    })) { throw new Error('Approved profile supplies are malformed.'); }
  }
  const identities = scopes.map(function (item) {
    return item === '*' ? item : normalizeCellText_(normalizeSupplyType_(item));
  });
  if (identities.some(function (identity) { return !identity; }) ||
    contract && contract.supplies.some(function (supply) { return !normalizeSupplyType_(supply); }) ||
    new Set(identities).size !== identities.length ||
    contract && identities.indexOf('*') < 0 && contract.supplies.some(function (supply) {
      return identities.indexOf(normalizeCellText_(normalizeSupplyType_(supply))) < 0;
    })) { throw new Error('Approved contract supply scope conflicts with its profile.'); }
  return identities;
}

function getInvoiceContract_(extracted) {
  return extracted && extracted.invoice_contract_ || null;
}

function getInvoiceReferenceDate_(extracted) {
  return extracted && extracted.period_start || '';
}

function applyInvoiceReferencePeriod_(extracted) {
  if (!extracted || extracted.document_type !== 'Invoice') { return; }
  const date = getInvoiceReferenceDate_(extracted);
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    extracted.reference_year = Number(date.slice(0, 4));
    extracted.reference_month = date.slice(5, 7);
  }
}

// Extraction keeps a numeric month anchor for the provider schema and cadence.
// Only the sheet presentation expands it; no cost is apportioned to a month.
function formatInvoiceReferenceMonth_(extracted) {
  const start = extracted && extracted.period_start;
  const end = extracted && extracted.period_end;
  if (!isValidIsoDate_(start) || !isValidIsoDate_(end) || end < start ||
    Number(start.slice(0, 4)) < 1900 || Number(end.slice(0, 4)) > 2200) {
    throw new Error('A valid, ordered billed service period is required.');
  }
  if (start.slice(0, 7) === end.slice(0, 7)) { return start.slice(5, 7); }
  if (start.slice(0, 4) === end.slice(0, 4)) {
    return start.slice(5, 7) + '–' + end.slice(5, 7);
  }
  return start.slice(5, 7) + '/' + start.slice(0, 4) + '–' +
    end.slice(5, 7) + '/' + end.slice(0, 4);
}

function bindInvoiceContract_(extracted, policy) {
  // The model may not supply executable policy or retain an earlier binding.
  delete extracted.invoice_contract_;
  Object.defineProperty(extracted, 'invoice_contract_', {
    value: getApprovedInvoiceContract_(policy, extracted), enumerable: false, configurable: true
  });
  const contract = getInvoiceContract_(extracted);
  if (contract && !extracted.customer_code && contract.customer_code_prefixes.some(function (prefix) {
    return extracted.contract_number.indexOf(prefix) === 0 &&
      extracted.contract_number.length > prefix.length;
  })) {
    extracted.customer_code = extracted.contract_number;
    extracted.contract_number = '';
  } else if (contract && contract.customer_code_prefixes.some(function (prefix) {
    return extracted.contract_number.indexOf(prefix) === 0 &&
      extracted.contract_number.length > prefix.length;
  })) {
    if (extracted.contract_number !== extracted.customer_code) {
      extracted.problems = (extracted.problems || []).concat('Subscriber identifier evidence conflicts.');
    } else { extracted.contract_number = ''; }
  }
}

function validateSourceComponentsShape_(extracted) {
  if (extracted.source_components === undefined || extracted.source_components === null) { return; }
  const seen = Object.create(null);
  if (!Array.isArray(extracted.source_components) || extracted.source_components.length > 100 ||
    extracted.source_components.some(function (component) {
      if (!component || typeof component !== 'object' || Array.isArray(component) ||
        Object.keys(component).some(function (key) { return ['id', 'amount', 'source_evidence', 'absence_evidence'].indexOf(key) < 0; }) ||
        typeof component.id !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(component.id) || seen[component.id] ||
        typeof component.amount !== 'number' || !Number.isFinite(component.amount) ||
        ['printed', 'explicit_absence'].indexOf(component.source_evidence) < 0 ||
        component.absence_evidence != null && (typeof component.absence_evidence !== 'string' || component.absence_evidence.length > 1000)) { return true; }
      seen[component.id] = true;
      return false;
    })) { throw new Error('Gemini source_components are malformed or duplicated.'); }
}

function invoiceContractFailure_(fields) {
  return invalidExtraction_('Invoice source evidence does not satisfy its approved cost contract.',
    'Re-read the printed source components and their parent subtotals using the matching approved profile. ' +
      'Resolve missing, conflicting, repeated or wrongly allocated evidence without changing VAT or the final total to balance it.',
    { code: 'invoice_cost_reconciliation_mismatch', repairable: true,
      fields: ['source_components', 'sheet_values', 'cost_consumption', 'cost_non_consumption', 'vat', 'total'].concat(fields || []) });
}

function evaluateInvoiceContract_(extracted, applyMapping) {
  const contract = getInvoiceContract_(extracted);
  if (!contract) { return { valid: true }; }
  const fail = function (fields) {
    return invoiceContractFailure_((fields || []).concat((contract.products || []).reduce(function (all, check) {
      return all.concat([check.quantity_header, check.rate_header]);
    }, [])));
  };
  try { validateSourceComponentsShape_(extracted); } catch (error) { return fail(); }
  const provided = extracted.source_components || [];
  const evidence = Object.create(null);
  provided.forEach(function (item) { evidence[item.id] = item; });
  if (provided.length !== contract.components.length || contract.components.some(function (component) {
    const item = evidence[component.id];
    return !item || item.source_evidence === 'explicit_absence' &&
      (component.absence_value === undefined || item.amount !== component.absence_value ||
        typeof item.absence_evidence !== 'string' || !component.absence_statements.some(function (statement) {
          return normalizeCellText_(statement) === normalizeCellText_(item.absence_evidence);
        }));
  })) { return fail(); }
  const source = function (ref, candidate) {
    if (evidence[ref]) { return evidence[ref].amount; }
    if (ref.indexOf('field:') === 0) { return candidate[ref.slice(6)]; }
    if (!isNumericInvoiceHeader_(ref.slice(7))) { return null; }
    const field = readConfiguredReconciliationField_(candidate, [ref.slice(7)]);
    if (field.configured && !field.duplicate && field.absent &&
      isInvoiceCoreMonetaryReconciled_(candidate)) { return 0; }
    return field.configured && !field.duplicate && field.present ? field.value : null;
  };
  const checksPass = function (candidate, sourceOnly) {
    return contract.checks.every(function (check) {
      if (sourceOnly && [check.total].concat(check.parts).some(function (ref) { return ref.indexOf(':') >= 0; })) { return true; }
      const values = [check.total].concat(check.parts).map(function (ref) { return source(ref, candidate); });
      return values.every(function (value) { return typeof value === 'number' && Number.isFinite(value); }) &&
        Math.abs(values[0] - values.slice(1).reduce(function (sum, value) { return sum + value; }, 0)) <= CONFIG.MONEY_TOLERANCE;
    });
  };
  if (!checksPass(extracted, true)) { return fail(); }
  const candidate = Object.assign({}, extracted, {
    sheet_values: (extracted.sheet_values || []).map(function (entry) { return Object.assign({}, entry); })
  });
  Object.defineProperty(candidate, 'configured_writable_headers', {
    value: extracted.configured_writable_headers || (extracted.sheet_values || []).map(function (entry) {
      return entry.header;
    }), enumerable: false
  });
  Object.defineProperty(candidate, 'configured_secondary_headers', {
    value: extracted.configured_secondary_headers || [], enumerable: false
  });
  Object.defineProperty(candidate, 'invoice_contract_', { value: contract, enumerable: false });
  for (let index = 0; index < contract.allocations.length; index += 1) {
    const allocation = contract.allocations[index];
    const amount = Math.round(allocation.parts.reduce(function (sum, id) { return sum + evidence[id].amount; }, 0) * 100) / 100;
    const isField = allocation.target.indexOf('field:') === 0;
    const name = allocation.target.slice(isField ? 6 : 7);
    const field = isField ? null : readConfiguredReconciliationField_(candidate, [name]);
    // A profile cannot authorize writing a missing or formula-backed column.
    if (field && (!field.configured || field.duplicate || !isInvoiceContractWritableMoneyHeader_(name))) {
      return fail([name]);
    }
    const current = isField ? candidate[name] : field.value;
    const present = isField ? current !== undefined && current !== null : field.present;
    const accepted = [amount].concat((allocation.replace_from || []).map(function (id) { return evidence[id].amount; }));
    if (applyMapping && present && (typeof current !== 'number' || !Number.isFinite(current) ||
      !accepted.some(function (value) { return Math.abs(current - value) <= CONFIG.MONEY_TOLERANCE; }))) {
      return fail([name]);
    }
    if (!applyMapping && (typeof current !== 'number' || !Number.isFinite(current) ||
      Math.abs(current - amount) > CONFIG.MONEY_TOLERANCE)) { return fail([name]); }
    if (isField) { candidate[name] = amount; }
    else {
      const entry = candidate.sheet_values.find(function (item) { return normalizeHeader_(item.header) === normalizeHeader_(name); });
      if (entry) { entry.value = amount; } else { candidate.sheet_values.push({ header: field.header, value: amount }); }
    }
  }
  if (!checksPass(candidate, false) || !isInvoiceCoreMonetaryReconciled_(candidate)) { return fail(); }
  for (const check of contract.products) {
    const quantity = readConfiguredReconciliationField_(candidate, [check.quantity_header]);
    const rate = readConfiguredReconciliationField_(candidate, [check.rate_header]);
    const amount = source(check.total, candidate);
    if ([quantity, rate].some(function (field) {
      return !field.configured || field.duplicate || !field.present ||
        typeof field.rawValue !== 'number' || !Number.isFinite(field.rawValue) || field.rawValue < 0;
    }) || typeof amount !== 'number' || !Number.isFinite(amount) ||
      Math.abs(quantity.rawValue * rate.rawValue - amount) > CONFIG.MONEY_TOLERANCE) {
      return fail([check.quantity_header, check.rate_header]);
    }
  }
  if (applyMapping) {
    const registry = getLocalizationRegistry_();
    const copies = { consumptionCost: 'cost_consumption', nonConsumptionCosts: 'cost_non_consumption' };
    for (const role of Object.keys(copies)) {
      const aliases = Object.keys(registry).reduce(function (all, locale) {
        return all.concat(registry[locale].headerAliases[role]);
      }, []);
      const field = readConfiguredReconciliationField_(candidate, aliases);
      const name = copies[role];
      if (field.duplicate || field.present && (field.value === null ||
        Math.abs(field.value - candidate[name]) > CONFIG.MONEY_TOLERANCE &&
        (typeof extracted[name] !== 'number' || !Number.isFinite(extracted[name]) ||
          Math.abs(field.value - extracted[name]) > CONFIG.MONEY_TOLERANCE))) {
        return fail([field.header]);
      }
      candidate.sheet_values.forEach(function (entry) {
        if (aliases.map(normalizeHeader_).indexOf(normalizeHeader_(entry.header)) >= 0) {
          entry.value = candidate[name];
        }
      });
    }
  }
  if (!validateInvoiceMonetaryOverlays_(candidate,
    'invoice_cost_reconciliation_mismatch', 'Invoice').valid) { return fail(); }
  if (applyMapping && !getBlockingInvoiceProblems_(candidate, { allowAccessory: true }).length) {
    extracted.cost_consumption = candidate.cost_consumption;
    extracted.cost_non_consumption = candidate.cost_non_consumption;
    extracted.sheet_values = candidate.sheet_values;
  }
  return { valid: true };
}
