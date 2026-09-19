import test from "node:test";
import assert from "node:assert/strict";
import { effectivePrice, profitMetrics } from "../src/services/pricingService.js";
import { generateNextMonthTarget, weightedAchievement } from "../src/services/targetService.js";
import { customerHealth } from "../src/services/healthService.js";

test("effective price includes discount and free quantity",()=>{
  assert.equal(effectivePrice({rate:110,discountPct:10,qty:10,freeQty:1}),90);
});

test("pricing blocks below product minimum",()=>{
  const result=profitMetrics({landedCost:100,effectiveSellingPrice:102,minimumProfitPct:3});
  assert.equal(result.allowed,false);
  assert.equal(result.color,"BLOCKED");
});

test("next month target reconciles to remaining annual target",()=>{
  const result=generateNextMonthTarget({annualTarget:1200000,achieved:150000,remainingMonths:10,seasonalityFactor:1});
  assert.equal(result.remaining,1050000);
  assert.equal(result.baseMonthlyRunRate,105000);
});

test("weighted achievement respects configured dimensions",()=>{
  const score=weightedAchievement({sales:100,grossProfit:100,collection:100,productMix:100,marginQuality:100,newCustomers:100,leadsVisits:100});
  assert.equal(score,100);
});

test("customer health grades strong customer",()=>{
  const h=customerHealth({gstScore:100,paymentScore:90,receiptScore:90,bounceScore:100,overdueScore:85,relationshipScore:80});
  assert.ok(h.score>=85);
  assert.equal(h.grade,"A");
});
