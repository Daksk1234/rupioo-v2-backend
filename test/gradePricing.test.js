import test from "node:test";
import assert from "node:assert/strict";
import {
  gradeBasicFromMrp,
  mrpBasicExcludingGst,
  priceFromOldDmsLogic,
} from "../src/services/oldDmsPricingService.js";

test("grade basic is derived from MRP after GST removal", () => {
  assert.equal(mrpBasicExcludingGst(16.59, 12), 14.81);
  assert.equal(gradeBasicFromMrp(16.59, 12, 15), 12.59);
});

test("highest grade reverses MRP loading back to target sale rate", () => {
  const priced = priceFromOldDmsLogic(
    { salePrice: 12.28, gstRate: 12, profitPercentage: 5 },
    15,
    { saleRateOverride: 12.28, profitOverride: 5 },
  );
  assert.equal(gradeBasicFromMrp(priced.mrp, 12, 15), 12.28);
});
