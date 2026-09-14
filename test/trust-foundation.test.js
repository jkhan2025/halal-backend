"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeProductTrust,
  normalizePlaceTrust,
  withProductTrust,
  withPlaceTrust,
} = require("../src/domain/trust");

const TEST_CERT = (scope = { kind: "PRODUCT", target: "test-sku" }) => ({
  id: "test-cert-1",
  type: "CERTIFIED",
  reviewState: "ACCEPTED",
  title: "Test fixture certificate",
  authorityName: "Test Fixture Authority",
  scope,
});

test("UNKNOWN cannot become HALAL merely because evidence is absent", () => {
  assert.equal(normalizeProductTrust({ trust: { verdict: "HALAL" } }).verdict, "UNKNOWN");
});

test("ingredient-only analysis cannot masquerade as certification", () => {
  const trust = normalizeProductTrust({ trust: {
    verdict: "HALAL",
    evidence: [{ id: "analysis-1", type: "INGREDIENT_ANALYSIS", reviewState: "ACCEPTED", title: "Test fixture analysis", scope: { kind: "PRODUCT", target: "test-sku" } }],
  } });
  assert.equal(trust.verdict, "UNKNOWN");
  assert.equal(trust.certification, null);
  assert.equal(trust.evidenceLevel, "INGREDIENT_ANALYSIS");
});

test("community report cannot masquerade as certification", () => {
  const trust = normalizeProductTrust({ trust: {
    evidence: [{ type: "COMMUNITY_REPORTED", reviewState: "UNREVIEWED", scope: { kind: "PRODUCT", target: "test-sku" } }],
  } });
  assert.equal(trust.certification, null);
  assert.equal(trust.evidenceLevel, "COMMUNITY_REPORTED");
});

test("business confirmation cannot masquerade as certification", () => {
  const trust = normalizePlaceTrust({ trust: {
    evidence: [{ id: "test-business-1", type: "BUSINESS_CONFIRMED", reviewState: "ACCEPTED", title: "Test fixture confirmation", publisher: "Test Fixture Business", scope: { kind: "BUSINESS", target: "test-place" } }],
  } });
  assert.equal(trust.certification, null);
  assert.equal(trust.evidenceLevel, "CONFIRMED");
});

test("grocery partial scope cannot imply entire-store certification", () => {
  const trust = normalizePlaceTrust({ type: "grocery", trust: {
    verdict: "HALAL",
    evidence: [TEST_CERT({ kind: "PRODUCT_SELECTION", target: "test-selection" })],
  } });
  assert.equal(trust.verdict, "UNKNOWN");
  assert.equal(trust.certification.scope.kind, "PRODUCT_SELECTION");
});

test("brand-level evidence cannot automatically become SKU certification", () => {
  const trust = normalizeProductTrust({ trust: {
    verdict: "HALAL",
    evidence: [TEST_CERT({ kind: "BRAND", target: "test-brand" })],
  } });
  assert.equal(trust.verdict, "UNKNOWN");
  assert.equal(trust.certification, null);
});

test("missing evidence remains missing", () => {
  assert.deepEqual(normalizeProductTrust({}).evidence, []);
});

test("evidence dates are not fabricated", () => {
  const trust = normalizeProductTrust({ trust: { evidence: [TEST_CERT()] } });
  assert.equal(trust.checkedAt, null);
  assert.equal(trust.evidence[0].sourceDate, null);
  assert.equal(trust.evidence[0].checkedAt, null);
});

test("region and formulation are not fabricated", () => {
  const trust = normalizeProductTrust({ barcode: "test-code" });
  assert.equal(trust.identity.region, null);
  assert.equal(trust.identity.formulation, null);
  assert.equal(trust.scope.region, null);
});

test("possible animal source is not presented as product-specific without evidence", () => {
  const trust = normalizeProductTrust({ trust: { factors: [{
    possibleSources: ["animal", "plant"],
    productSpecificSource: { state: "UNKNOWN", value: "animal" },
  }] } });
  assert.equal(trust.factors[0].productSpecificSource.value, null);
  assert.deepEqual(trust.factors[0].possibleSources, ["animal", "plant"]);
});

test("possible pork source is not presented as actual origin without evidence", () => {
  const trust = normalizeProductTrust({ trust: { factors: [{
    possibleSources: ["pork"],
    productSpecificSource: { state: "OTHER_SUPPORTED", value: "pork", evidenceRefs: [] },
  }] } });
  assert.equal(trust.factors[0].productSpecificSource.state, "UNKNOWN");
  assert.equal(trust.factors[0].productSpecificSource.value, null);
});

test("unknown ingredient source remains explicitly unknown", () => {
  const trust = normalizeProductTrust({ trust: { factors: [{ label: "Test ingredient" }] } });
  assert.equal(trust.factors[0].productSpecificSource.state, "UNKNOWN");
});

test("general ingredient knowledge remains separate from product-specific evidence", () => {
  const trust = normalizeProductTrust({ trust: { factors: [{
    generalKnowledge: ["General test fact"],
    possibleSources: ["source A", "source B"],
  }] } });
  assert.deepEqual(trust.factors[0].generalKnowledge, ["General test fact"]);
  assert.deepEqual(trust.factors[0].productSpecificSource.evidenceRefs, []);
});

test("trigger explanation does not change the canonical verdict", () => {
  const trust = normalizeProductTrust({ trust: {
    verdict: "NEEDS_REVIEW",
    factors: [{ role: "UNRESOLVED", label: "Test factor", finding: "Plain-language test explanation", status: "POSSIBLE" }],
  } });
  assert.equal(trust.verdict, "NEEDS_REVIEW");
  assert.equal(trust.factors[0].finding, "Plain-language test explanation");
});

test("explanation facts retain evidence references", () => {
  const trust = normalizeProductTrust({ trust: {
    verdict: "HARAM",
    evidence: [{ id: "test-source-1", type: "INGREDIENT_ANALYSIS", reviewState: "ACCEPTED", title: "Test fixture analysis", scope: { kind: "PRODUCT", target: "test-sku" } }],
    factors: [{ role: "DECISIVE", status: "CONFIRMED", evidenceRefs: ["test-source-1"], productSpecificSource: { state: "VERIFIED_PRODUCT_SPECIFIC", value: "test origin", evidenceRefs: ["test-source-1"] } }],
    verified: [{ id: "test-fact-1", text: "Traceable test fact", evidenceRefs: ["test-source-1"] }],
  } });
  assert.equal(trust.verdict, "HARAM");
  assert.deepEqual(trust.factors[0].evidenceRefs, ["test-source-1"]);
  assert.deepEqual(trust.factors[0].productSpecificSource.evidenceRefs, ["test-source-1"]);
  assert.deepEqual(trust.verified[0].evidenceRefs, ["test-source-1"]);
});

test("legacy decisive product and place claims normalize conservatively", () => {
  assert.equal(withProductTrust({ verdict: "HALAL" }).trust.verdict, "UNKNOWN");
  assert.equal(withPlaceTrust({ halal: true, certified: true }).trust.verdict, "UNKNOWN");
  assert.equal(withPlaceTrust({ halal: true, certified: true }).trust.certification, null);
});

test("legacy MUSHBOOH maps to canonical NEEDS_REVIEW", () => {
  assert.equal(normalizeProductTrust({ verdict: "MUSHBOOH" }).verdict, "NEEDS_REVIEW");
});

test("accepted, scoped product certification can support HALAL", () => {
  const trust = normalizeProductTrust({ trust: { verdict: "HALAL", evidence: [TEST_CERT()] } });
  assert.equal(trust.verdict, "HALAL");
  assert.equal(trust.certification.authorityName, "Test Fixture Authority");
});
