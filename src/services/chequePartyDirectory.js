// Cheque Control uses the company Debtor/Creditor master, never a global
// cross-tenant party list. BOTH = party that can be debtor and creditor.
export const chequePartyFilter = (tenantKey, query = '') => {
  const filter = {
    tenantKey,
    status: { $nin: ['INACTIVE', 'DEACTIVATED', 'DELETED'] },
    $and: [{
      $or: [
        { partyType: { $in: ['DEBITOR', 'CREDITOR', 'BOTH'] } },
        // Legacy CustomerLink records without a party type default to DEBITOR.
        { partyType: { $exists: false } },
        { partyType: null },
      ],
    }],
  };
  const q = String(query || '').trim().slice(0, 100);
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$and.push({ $or: [
      { localName: { $regex: escaped, $options: 'i' } },
      { displayIdentifier: { $regex: escaped, $options: 'i' } },
      { legalName: { $regex: escaped, $options: 'i' } },
      { tradeName: { $regex: escaped, $options: 'i' } },
    ] });
  }
  return filter;
};

export const chequePartyRow = (row) => ({
  id: String(row.globalCustomerId || ''),
  name: row.localName || row.displayIdentifier || row.globalCustomerId,
  partyType: String(row.partyType || 'DEBITOR').trim().toUpperCase(),
  identifier: row.displayIdentifier || '',
});
