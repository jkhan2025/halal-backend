"use strict";

const assert = require("node:assert/strict");
const { test, after, mock } = require("node:test");
const net = require("node:net");
const tls = require("node:tls");

const forbidden = [];
const deny = (name) => {
  forbidden.push(name);
  throw new Error(`Isolated grocery contract test forbids ${name}`);
};
mock.method(net.Socket.prototype, "connect", () => deny("network"));
mock.method(tls, "connect", () => deny("TLS"));

const {
  buildGroceryResultContract,
  buildGroceryListProjection,
  buildGroceryDetailProjection,
  normalizeCoverage,
  SUMMARY_STATUSES,
  COVERAGE_KINDS,
} = require("../src/domain/groceryTrust");

after(() => {
  try {
    assert.deepEqual(forbidden, []);
    for (const filename of ["../server.js", "../index.js", "../src/app.js"]) {
      assert.equal(require.cache[require.resolve(filename)], undefined, "application server must not load");
    }
    assert.equal(require.cache[require.resolve("dotenv")], undefined, "dotenv must not load");
  } finally {
    mock.restoreAll();
  }
});

const NOW = new Date("2026-01-15T12:00:00.000Z");
const PLACE_A = "synthetic-grocery-a";
const PLACE_B = "synthetic-grocery-b";
const CHAIN_A = "synthetic-grocery-chain-a";
const AUTHORITY = "Synthetic Test Grocery Certification Authority";

const subject = (placeId = PLACE_A, chainId = null) => ({ placeId, chainId });
const entireStore = (placeId = PLACE_A) => ({ kind: "ENTIRE_STORE", placeId });
const coverage = (kind, overrides = {}) => ({ kind, placeId: PLACE_A, ...overrides });

function certificateEvidence(overrides = {}) {
  return {
    id: "synthetic-evidence-cert",
    type: "CERTIFICATE",
    subject: subject(),
    coverage: entireStore(),
    issuer: { type: "CERTIFICATION_AUTHORITY", id: "synthetic-authority", name: AUTHORITY },
    sourceRef: "synthetic-certificate-source",
    reviewState: "ACCEPTED",
    checkedAt: "2026-01-10T00:00:00.000Z",
    relatedClaimRefs: ["synthetic-claim-cert"],
    certification: {
      authorityName: AUTHORITY,
      certificateId: "SYNTHETIC-GROCERY-CERT-001",
      status: "ACTIVE",
      validFrom: "2025-01-01T00:00:00.000Z",
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    ...overrides,
  };
}

function certificationClaim(overrides = {}) {
  return {
    id: "synthetic-claim-cert",
    type: "INDEPENDENT_CERTIFICATION",
    position: "AFFIRMS",
    subject: subject(),
    coverage: entireStore(),
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-cert"],
    ...overrides,
  };
}

function businessEvidence(overrides = {}) {
  return {
    id: "synthetic-evidence-business",
    type: "BUSINESS_ATTESTATION",
    subject: subject(),
    coverage: entireStore(),
    issuer: { type: "OWNER", id: "synthetic-owner", name: "Synthetic Fixture Grocery Owner" },
    sourceRef: "synthetic-business-attestation",
    reviewState: "ACCEPTED",
    ...overrides,
  };
}

function businessClaim(overrides = {}) {
  return {
    id: "synthetic-claim-business",
    type: "BUSINESS_CONFIRMATION",
    position: "AFFIRMS",
    subject: subject(),
    coverage: entireStore(),
    claimant: { type: "OWNER", id: "synthetic-owner", name: "Synthetic Fixture Grocery Owner" },
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-business"],
    ...overrides,
  };
}

function makePlace({ placeId = PLACE_A, claims = [], evidence = [], groceryTrust = {}, legacy = {} } = {}) {
  return {
    _id: placeId,
    type: "grocery",
    name: "Synthetic Contract Grocery",
    city: "Fixture City",
    state: "ZZ",
    ...legacy,
    groceryTrust: {
      version: 1,
      claims,
      evidence,
      unknowns: [],
      limitations: [],
      nextActions: [],
      ...groceryTrust,
    },
  };
}

const contract = (options = {}) => buildGroceryResultContract(makePlace(options), { now: NOW });

test("legacy halal:true alone remains UNVERIFIED and creates no evidence", () => {
  const result = contract({ legacy: { halal: true } });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.deepEqual(result.acceptedClaims, []);
  assert.deepEqual(result.acceptedEvidence, []);
});

test("legacy certified:true alone creates no accepted certification", () => {
  const result = contract({ legacy: { certified: true } });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.equal(result.evidenceLevel, "UNVERIFIED");
});

test("valid exact-location entire-store certification supports CERTIFIED", () => {
  const result = contract({ claims: [certificationClaim()], evidence: [certificateEvidence()] });
  assert.equal(result.summary.status, "CERTIFIED");
  assert.equal(result.summary.placeId, PLACE_A);
  assert.equal(result.summary.appliesToExactLocation, true);
  assert.equal(result.summary.isWholeLocation, true);
  assert.deepEqual(result.summary.supportingClaimIds, ["synthetic-claim-cert"]);
  assert.equal(result.acceptedEvidence[0].certification.certificateId, "SYNTHETIC-GROCERY-CERT-001");
});

test("certification for Grocery A cannot certify Grocery B", () => {
  const result = contract({ placeId: PLACE_B, claims: [certificationClaim()], evidence: [certificateEvidence()] });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.equal(result.summary.placeId, PLACE_B);
  assert.deepEqual(result.acceptedClaims, []);
});

test("valid exact-location meat-department certification remains partial, not entire-store", () => {
  const meatCoverage = coverage("MEAT_DEPARTMENT");
  const result = contract({
    claims: [certificationClaim({ coverage: meatCoverage })],
    evidence: [certificateEvidence({ coverage: meatCoverage })],
  });
  assert.equal(result.summary.status, "PARTIAL_SUPPORT");
  assert.notEqual(result.summary.status, "CERTIFIED");
  assert.equal(result.summary.isWholeLocation, false);
  assert.equal(result.summary.isPartial, true);
  assert.equal(result.coverage[0].kind, "MEAT_DEPARTMENT");
  assert.match(result.whatWeDontKnow.join(" "), /does not cover the entire grocery store/i);
});

test("valid limited product-category evidence remains visibly partial", () => {
  const categoryCoverage = coverage("PRODUCT_CATEGORY", { categoryId: "synthetic-frozen-category" });
  const claim = {
    id: "synthetic-claim-category",
    type: "PRODUCT_CATEGORY_CLAIM",
    position: "AFFIRMS",
    subject: subject(),
    coverage: categoryCoverage,
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-category"],
  };
  const evidence = {
    id: "synthetic-evidence-category",
    type: "PRODUCT_CATEGORY_DOCUMENT",
    subject: subject(),
    coverage: categoryCoverage,
    issuer: { type: "BUSINESS", id: "synthetic-business", name: "Synthetic Fixture Grocery Business" },
    sourceRef: "synthetic-category-document",
    reviewState: "ACCEPTED",
  };
  const result = contract({ claims: [claim], evidence: [evidence] });
  assert.equal(result.summary.status, "PARTIAL_SUPPORT");
  assert.equal(result.summary.isWholeLocation, false);
  assert.equal(result.coverage[0].kind, "PRODUCT_CATEGORY");
  assert.equal(result.coverage[0].categoryId, "synthetic-frozen-category");
});

test("product-level certification only (PRODUCT_SELECTION) cannot become whole-store certification", () => {
  const selectionCoverage = coverage("PRODUCT_SELECTION", { selectionId: "synthetic-product-line" });
  const result = contract({
    claims: [certificationClaim({ coverage: selectionCoverage })],
    evidence: [certificateEvidence({ coverage: selectionCoverage })],
  });
  assert.equal(result.summary.status, "PARTIAL_SUPPORT");
  assert.notEqual(result.summary.status, "CERTIFIED");
  assert.equal(result.coverage[0].kind, "PRODUCT_SELECTION");
  assert.equal(result.coverage[0].selectionId, "synthetic-product-line");
});

test("supplier evidence alone cannot become a halal status", () => {
  const supplierCoverage = coverage("NAMED_SUPPLIER", { supplierId: "synthetic-supplier" });
  const claim = {
    id: "synthetic-claim-supplier",
    type: "SUPPLIER_RELATIONSHIP",
    position: "INFORMATIONAL",
    subject: subject(),
    coverage: supplierCoverage,
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-supplier"],
  };
  const evidence = {
    id: "synthetic-evidence-supplier",
    type: "SUPPLIER_DOCUMENT",
    subject: subject(),
    coverage: supplierCoverage,
    issuer: { type: "SUPPLIER", id: "synthetic-supplier", name: "Synthetic Fixture Supplier" },
    sourceRef: "synthetic-supplier-record",
    reviewState: "ACCEPTED",
  };
  const result = contract({ claims: [claim], evidence: [evidence] });
  assert.equal(result.acceptedClaims.length, 1);
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("business-confirmed exact location remains distinct from certification", () => {
  const result = contract({ claims: [businessClaim()], evidence: [businessEvidence()] });
  assert.equal(result.summary.status, "BUSINESS_CONFIRMED");
  assert.equal(result.evidenceLevel, "BUSINESS_CONFIRMATION");
  assert.notEqual(result.summary.status, "CERTIFIED");
});

test("business confirmation cannot become independent certification even with entire-store coverage", () => {
  const result = contract({ claims: [businessClaim()], evidence: [businessEvidence()] });
  assert.notEqual(result.summary.status, "CERTIFIED");
  assert.equal(result.summary.evidenceLevel, "BUSINESS_CONFIRMATION");
});

test("community-reported exact location remains distinct from business confirmation and certification", () => {
  const claim = {
    id: "synthetic-claim-community",
    type: "COMMUNITY_REPORT",
    position: "AFFIRMS",
    subject: subject(),
    coverage: entireStore(),
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-community"],
  };
  const evidence = {
    id: "synthetic-evidence-community",
    type: "COMMUNITY_REPORT",
    subject: subject(),
    coverage: entireStore(),
    issuer: { type: "COMMUNITY_MEMBER", id: "synthetic-community-member" },
    sourceRef: "synthetic-community-report",
    reviewState: "ACCEPTED",
  };
  const result = contract({ claims: [claim], evidence: [evidence] });
  assert.equal(result.summary.status, "COMMUNITY_REPORTED");
  assert.notEqual(result.summary.status, "BUSINESS_CONFIRMED");
  assert.notEqual(result.summary.status, "CERTIFIED");
});

test("community report cannot become business confirmation or certification via relabeling alone", () => {
  const claim = {
    id: "synthetic-claim-community-2",
    type: "COMMUNITY_REPORT",
    position: "AFFIRMS",
    subject: subject(),
    coverage: entireStore(),
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-community-2"],
  };
  const evidence = {
    id: "synthetic-evidence-community-2",
    type: "COMMUNITY_REPORT",
    subject: subject(),
    coverage: entireStore(),
    issuer: { type: "COMMUNITY_MEMBER", id: "synthetic-community-member-2", name: "Synthetic Reporter" },
    sourceRef: "synthetic-community-report-2",
    reviewState: "ACCEPTED",
  };
  const result = contract({ claims: [claim], evidence: [evidence] });
  assert.equal(result.evidenceLevel, "COMMUNITY_REPORT");
  assert.notEqual(result.evidenceLevel, "BUSINESS_CONFIRMATION");
  assert.notEqual(result.evidenceLevel, "INDEPENDENT_CERTIFICATION");
});

test("chain-level evidence only remains separate and cannot verify an exact branch", () => {
  const chainCoverage = { kind: "CHAIN_LEVEL_ONLY", chainId: CHAIN_A };
  const chainSubject = { chainId: CHAIN_A };
  const result = contract({
    groceryTrust: { chain: { chainId: CHAIN_A, name: "Synthetic Fixture Grocery Chain" } },
    claims: [certificationClaim({ subject: chainSubject, coverage: chainCoverage })],
    evidence: [certificateEvidence({ subject: chainSubject, coverage: chainCoverage })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.equal(result.chain.chainId, CHAIN_A);
  assert.equal(result.identity.placeId, PLACE_A);
  assert.equal(result.acceptedClaims[0].applicability, "CHAIN_ONLY");
  assert.match(result.whatWeDontKnow.join(" "), /chain-level claim/i);
});

test("partial evidence cannot become whole-store certification", () => {
  const meatCoverage = coverage("MEAT_DEPARTMENT");
  const claim = {
    id: "synthetic-claim-meat",
    type: "HALAL_MEAT_DEPARTMENT_CLAIM",
    position: "AFFIRMS",
    subject: subject(),
    coverage: meatCoverage,
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-meat"],
  };
  const evidence = {
    id: "synthetic-evidence-meat",
    type: "BUSINESS_ATTESTATION",
    subject: subject(),
    coverage: meatCoverage,
    issuer: { type: "OWNER", id: "synthetic-owner", name: "Synthetic Fixture Grocery Owner" },
    sourceRef: "synthetic-meat-attestation",
    reviewState: "ACCEPTED",
  };
  const result = contract({ claims: [claim], evidence: [evidence] });
  assert.equal(result.summary.status, "PARTIAL_SUPPORT");
  assert.notEqual(result.summary.status, "CERTIFIED");
  assert.notEqual(result.summary.status, "BUSINESS_CONFIRMED");
  assert.equal(result.summary.isWholeLocation, false);
});

for (const reviewState of ["REJECTED", "UNREVIEWED", "PENDING"]) {
  test(`${reviewState} evidence cannot support an authoritative status`, () => {
    const result = contract({
      claims: [certificationClaim()],
      evidence: [certificateEvidence({ reviewState })],
    });
    assert.equal(result.summary.status, "UNVERIFIED");
  });
}

test("expired certification cannot support CERTIFIED", () => {
  const result = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ certification: { ...certificateEvidence().certification, status: "EXPIRED" } })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("revoked certification cannot support CERTIFIED", () => {
  const result = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ certification: { ...certificateEvidence().certification, status: "REVOKED" } })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("past expiry date blocks certification even when status still says ACTIVE", () => {
  const result = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ certification: { ...certificateEvidence().certification, expiresAt: "2025-01-01T00:00:00.000Z" } })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("missing/unknown certification status is not treated as active", () => {
  const result = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ certification: { ...certificateEvidence().certification, status: "UNKNOWN" } })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("wrong-location evidence (bound to another exact place) cannot support this location", () => {
  const otherPlaceSubject = subject(PLACE_B);
  const otherPlaceCoverage = { kind: "ENTIRE_STORE", placeId: PLACE_B };
  const result = contract({
    claims: [certificationClaim({ subject: otherPlaceSubject, coverage: otherPlaceCoverage })],
    evidence: [certificateEvidence({ subject: otherPlaceSubject, coverage: otherPlaceCoverage })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.deepEqual(result.acceptedClaims, []);
});

test("conflicting evidence (affirming and disputing) degrades to UNVERIFIED", () => {
  const disputeClaim = {
    id: "synthetic-claim-dispute",
    type: "EXPERT_REVIEWED_FINDING",
    position: "DISPUTES",
    subject: subject(),
    coverage: entireStore(),
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-dispute"],
  };
  const disputeEvidence = {
    id: "synthetic-evidence-dispute",
    type: "EXPERT_REVIEW",
    subject: subject(),
    coverage: entireStore(),
    issuer: { type: "EXPERT", id: "synthetic-reviewer", name: "Synthetic Fixture Reviewer" },
    sourceRef: "synthetic-reviewed-finding",
    reviewState: "ACCEPTED",
  };
  const result = contract({
    claims: [certificationClaim(), disputeClaim],
    evidence: [certificateEvidence(), disputeEvidence],
  });
  assert.equal(result.acceptedClaims.length, 2);
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.match(result.limitations.join(" "), /conflicting claims/i);
});

test("no evidence produces the safe unknown contract", () => {
  const result = contract();
  assert.equal(result.contractVersion, 1);
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.match(result.whatWeDontKnow.join(" "), /no accepted claim/i);
  assert.equal(result.checkedAt, null);
});

test("malformed or dangling evidence references cannot support a claim", () => {
  const dangling = contract({ claims: [certificationClaim({ evidenceRefs: ["missing-evidence"] })] });
  assert.equal(dangling.summary.status, "UNVERIFIED");
  assert.deepEqual(dangling.acceptedClaims, []);

  const mismatched = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ coverage: coverage("PRODUCT_CATEGORY", { categoryId: "other-category" }) })],
  });
  assert.equal(mismatched.summary.status, "UNVERIFIED");
});

test("duplicate claim and evidence IDs are excluded safely", () => {
  const result = contract({
    claims: [certificationClaim(), certificationClaim()],
    evidence: [certificateEvidence(), certificateEvidence()],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.deepEqual(result.acceptedClaims, []);
  assert.match(result.limitations.join(" "), /duplicate or missing/i);
});

test("a free-text target alone cannot establish exact-location scope", () => {
  const result = contract({
    claims: [{
      ...certificationClaim(),
      subject: undefined,
      coverage: { kind: "ENTIRE_STORE", target: "Synthetic Contract Grocery" },
    }],
    evidence: [{
      ...certificateEvidence(),
      subject: undefined,
      coverage: { kind: "ENTIRE_STORE", target: "Synthetic Contract Grocery" },
    }],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("chain and exact location identities remain distinct", () => {
  const result = contract({
    groceryTrust: { chain: { chainId: CHAIN_A, name: "Synthetic Fixture Grocery Chain" } },
    claims: [businessClaim()],
    evidence: [businessEvidence()],
  });
  assert.deepEqual(result.chain, { chainId: CHAIN_A, name: "Synthetic Fixture Grocery Chain" });
  assert.equal(result.identity.placeId, PLACE_A);
  assert.notEqual(result.chain.chainId, result.identity.placeId);
});

test("structured coverage survives normalization", () => {
  assert.deepEqual(normalizeCoverage({
    kind: "PRODUCT_CATEGORY",
    placeId: PLACE_A,
    categoryId: "synthetic-category",
    label: "Synthetic category label",
  }), {
    kind: "PRODUCT_CATEGORY",
    placeId: PLACE_A,
    chainId: null,
    categoryId: "synthetic-category",
    selectionId: null,
    supplierId: null,
    label: "Synthetic category label",
  });
});

test("unestablished/unknown coverage kind is never valid", () => {
  assert.equal(COVERAGE_KINDS.includes("UNKNOWN"), false);
  const result = contract({
    claims: [certificationClaim({ coverage: { kind: "SOMETHING_UNDEFINED", placeId: PLACE_A } })],
    evidence: [certificateEvidence({ coverage: { kind: "SOMETHING_UNDEFINED", placeId: PLACE_A } })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("raw legacy booleans and storage-only trust data never enter public projections", () => {
  const place = makePlace({ legacy: { halal: true, certified: true, promo: { tier: "featured" }, metrics: { impressions: 99 } } });
  const list = buildGroceryListProjection(place, { now: NOW });
  const detail = buildGroceryDetailProjection(place, { now: NOW });
  for (const projection of [list, detail]) {
    assert.equal(Object.hasOwn(projection, "halal"), false);
    assert.equal(Object.hasOwn(projection, "certified"), false);
    assert.equal(Object.hasOwn(projection, "groceryTrust"), false);
    assert.equal(Object.hasOwn(projection, "restaurantTrust"), false);
    assert.equal(Object.hasOwn(projection, "promo"), false);
    assert.equal(Object.hasOwn(projection, "metrics"), false);
    assert.equal(projection.grocerySummary.status, "UNVERIFIED");
  }
});

test("Open Food Facts/product provenance cannot become grocery-location evidence", () => {
  const result = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ type: "OPEN_FOOD_FACTS" })],
    groceryTrust: { provenance: { recordSource: "OPEN_FOOD_FACTS", sourceRecordId: "synthetic-product-record" } },
  });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.equal(result.provenance.recordSource, "OPEN_FOOD_FACTS");
  assert.deepEqual(result.acceptedEvidence, []);
});

test("supplier and slaughter-method records remain factual and do not create a halal status", () => {
  const supplierCoverage = coverage("NAMED_SUPPLIER", { supplierId: "synthetic-supplier" });
  const claim = {
    id: "synthetic-claim-slaughter-info",
    type: "SLAUGHTER_METHOD_INFORMATION",
    position: "INFORMATIONAL",
    subject: subject(),
    coverage: supplierCoverage,
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-slaughter-info"],
  };
  const evidence = {
    id: "synthetic-evidence-slaughter-info",
    type: "SLAUGHTER_METHOD_DOCUMENT",
    subject: subject(),
    coverage: supplierCoverage,
    issuer: { type: "SUPPLIER", id: "synthetic-supplier", name: "Synthetic Fixture Supplier" },
    sourceRef: "synthetic-slaughter-method-record",
    reviewState: "ACCEPTED",
  };
  const result = contract({ claims: [claim], evidence: [evidence] });
  assert.equal(result.acceptedClaims.length, 1);
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("negative/non-halal status remains unsupported in Contract v1", () => {
  assert.equal(SUMMARY_STATUSES.includes("NOT_HALAL"), false);
  const result = contract({
    claims: [{
      id: "synthetic-negative-claim",
      type: "NON_HALAL_DETERMINATION",
      position: "AFFIRMS",
      subject: subject(),
      coverage: entireStore(),
      reviewState: "ACCEPTED",
      evidenceRefs: ["synthetic-negative-evidence"],
    }],
    evidence: [{
      id: "synthetic-negative-evidence",
      type: "EXPERT_REVIEW",
      subject: subject(),
      coverage: entireStore(),
      issuer: { type: "EXPERT", id: "synthetic-expert", name: "Synthetic Fixture Expert" },
      sourceRef: "synthetic-negative-review",
      reviewState: "ACCEPTED",
    }],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.deepEqual(result.acceptedClaims, []);
});

test("what-we-know facts require accepted claim and evidence references", () => {
  const result = contract({
    claims: [businessClaim()],
    evidence: [businessEvidence()],
    groceryTrust: {
      known: [
        {
          id: "synthetic-known-fact",
          text: "Synthetic owner confirmation was reviewed.",
          claimRefs: ["synthetic-claim-business"],
          evidenceRefs: ["synthetic-evidence-business"],
        },
        {
          id: "synthetic-dangling-fact",
          text: "This must not survive.",
          claimRefs: ["missing-claim"],
          evidenceRefs: ["missing-evidence"],
        },
      ],
      provenance: { recordSource: "SYNTHETIC_TEST", sourceRecordId: "synthetic-record" },
    },
  });
  assert.equal(result.whatWeKnow.length, 1);
  assert.equal(result.whatWeKnow[0].id, "synthetic-known-fact");
  assert.equal(result.provenance.recordSource, "SYNTHETIC_TEST");
});
