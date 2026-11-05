// One journal corresponds to one atomic Sheets batch. The caller derives the
// fingerprints from complete, identity-checked chart and reserved-block reads.
function reconcilePeriodChartTransaction_(store, sheets) {
  const journal = store.readJournal();
  if (!journal) { return { state: 'idle' }; }
  if (journal.version !== 1 || !journal.transactionId ||
    !journal.spreadsheetId || !journal.before || !journal.after ||
    journal.before === journal.after ||
    !journal.registration || ['prepared', 'sent'].indexOf(journal.phase) < 0) {
    throw new Error('Invalid period chart transaction journal.');
  }
  const observed = sheets.readFingerprint(journal);
  if (observed === journal.after) {
    if (journal.phase !== 'sent') {
      throw new Error('Period chart state changed before its batch was sent.');
    }
    // A write can succeed even if its response or a later local write fails.
    // Complete the registration without sending the Sheets batch again.
    store.saveRegistration(journal.registration, journal.previousRegistration);
    store.clearJournal();
    return { state: 'committed' };
  }
  if (observed !== journal.before) {
    throw new Error('Period chart state changed while a transaction was pending.');
  }
  if (journal.phase === 'sent') {
    // The write result is uncertain. Never automatically repeat it from an
    // observation of the old state: a timed-out request may still complete.
    return { state: 'uncertain' };
  }
  return { state: 'prepared' };
}

function commitPeriodChartTransaction_(store, sheets, transaction) {
  if (store.readJournal()) {
    throw new Error('A period chart transaction is already pending.');
  }
  if (!transaction || transaction.version !== 1 || !transaction.transactionId ||
    !transaction.spreadsheetId || !transaction.before || !transaction.after ||
    transaction.before === transaction.after || !transaction.registration ||
    !Array.isArray(transaction.requests) || !transaction.requests.length) {
    throw new Error('Invalid period chart transaction.');
  }
  if (sheets.readFingerprint(transaction) !== transaction.before) {
    throw new Error('Period chart state changed before the transaction.');
  }
  const journal = Object.assign({}, transaction, { phase: 'prepared' });
  store.saveJournal(journal);
  // Persist before invoking the provider, so an interruption cannot cause a
  // successful but unacknowledged write to be automatically sent twice.
  journal.phase = 'sent';
  store.saveJournal(journal);
  sheets.applyBatch(journal);
  const result = reconcilePeriodChartTransaction_(store, sheets);
  if (result.state !== 'committed') {
    throw new Error('Period chart batch could not be verified.');
  }
  return result;
}
