import test from 'node:test';
import assert from 'node:assert/strict';
import { permissionCatalogue } from '../src/config/permissionCatalogue.js';
import { REPORT_PERMISSION_MAP } from '../src/config/permissionPageMap.js';
import { oldDmsReferenceReportCatalog } from '../src/services/oldDmsReferenceReportsService.js';
import { v2LiveReportCatalog } from '../src/services/v2LiveReportsService.js';
import { legacyReportCatalog } from '../src/services/legacyReportsService.js';

const catalogueKeys = new Set(
  permissionCatalogue.flatMap(group => (group.screens || []).map(screen => screen.key))
);

const keysFor = name => {
  if (REPORT_PERMISSION_MAP[name]) return REPORT_PERMISSION_MAP[name];
  const wanted = String(name || '').trim().toLowerCase();
  return Object.entries(REPORT_PERMISSION_MAP).find(([label]) => label.toLowerCase() === wanted)?.[1] || [];
};

test('every old DMS report can pass the configured permission catalogue guard', () => {
  assert.equal(oldDmsReferenceReportCatalog.length, 53);
  for (const report of oldDmsReferenceReportCatalog) {
    const keys = keysFor(report.name);
    assert.ok(keys.length, `missing permission mapping for ${report.name}`);
    for (const key of keys) assert.ok(catalogueKeys.has(key), `${report.name} uses unknown permission key ${key}`);
  }
});

test('every implemented V2 live/native report has a real permission mapping', () => {
  const reports = [...v2LiveReportCatalog, ...legacyReportCatalog];
  for (const report of reports) {
    const keys = keysFor(report.name);
    assert.ok(keys.length, `missing permission mapping for ${report.name}`);
    for (const key of keys) assert.ok(catalogueKeys.has(key), `${report.name} uses unknown permission key ${key}`);
  }
});
