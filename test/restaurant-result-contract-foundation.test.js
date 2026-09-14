"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  buildRestaurantResultContract,
  buildRestaurantListProjection,
  buildRestaurantDetailProjection,
  normalizeCoverage,
  SUMMARY_STATUSES,
} = require("../src/domain/restaurantTrust");

const NOW = new Date("2026-01-15T12:00:00.000Z");
const PLACE_A = "synthetic-place-a";
const PLACE_B = "synthetic-place-b";
const CHAIN_A = "synthetic-chain-a";
const AUTHORITY = "Synthetic Test Certification Authority";

const subject = (placeId = PLACE_A, chainId = null) => ({ placeId, chainId });
const entire = (placeId = PLACE_A) => ({ kind: "ENTIRE_LOCATION", placeId });
const coverage = (kind, overrides = {}) => ({ kind, placeId: PLACE_A, ...overrides });

function certificateEvidence(overrides = {}) {
  return {
    id: "synthetic-evidence-cert",
    type: "CERTIFICATE",
    subject: subject(),
    coverage: entire(),
    issuer: { type: "CERTIFICATION_AUTHORITY", id: "synthetic-authority", name: AUTHORITY },
    sourceRef: "synthetic-certificate-source",
    reviewState: "ACCEPTED",
    checkedAt: "2026-01-10T00:00:00.000Z",
    relatedClaimRefs: ["synthetic-claim-cert"],
    certification: {
      authorityName: AUTHORITY,
      certificateId: "SYNTHETIC-CERT-001",
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
    coverage: entire(),
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
    coverage: entire(),
    issuer: { type: "OWNER", id: "synthetic-owner", name: "Synthetic Fixture Owner" },
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
    coverage: entire(),
    claimant: { type: "OWNER", id: "synthetic-owner", name: "Synthetic Fixture Owner" },
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-business"],
    ...overrides,
  };
}

function makePlace({ placeId = PLACE_A, claims = [], evidence = [], restaurantTrust = {}, legacy = {} } = {}) {
  return {
    _id: placeId,
    type: "restaurant",
    name: "Synthetic Contract Kitchen",
    city: "Fixture City",
    state: "ZZ",
    ...legacy,
    restaurantTrust: {
      version: 1,
      claims,
      evidence,
      unknowns: [],
      limitations: [],
      nextActions: [],
      ...restaurantTrust,
    },
  };
}

const contract = (options = {}) => buildRestaurantResultContract(makePlace(options), { now: NOW });

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

test("accepted active certification bound to the exact location supports CERTIFIED", () => {
  const result = contract({ claims: [certificationClaim()], evidence: [certificateEvidence()] });
  assert.equal(result.summary.status, "CERTIFIED");
  assert.equal(result.summary.placeId, PLACE_A);
  assert.equal(result.summary.appliesToExactLocation, true);
  assert.equal(result.summary.isWholeLocation, true);
  assert.deepEqual(result.summary.supportingClaimIds, ["synthetic-claim-cert"]);
  assert.equal(result.acceptedEvidence[0].certification.certificateId, "SYNTHETIC-CERT-001");
});

test("certification for Place A cannot certify Place B", () => {
  const result = contract({ placeId: PLACE_B, claims: [certificationClaim()], evidence: [certificateEvidence()] });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.equal(result.summary.placeId, PLACE_B);
  assert.deepEqual(result.acceptedClaims, []);
});

test("chain-level evidence remains separate and cannot certify a branch", () => {
  const chainCoverage = { kind: "CHAIN_LEVEL_ONLY", chainId: CHAIN_A };
  const chainSubject = { chainId: CHAIN_A };
  const result = contract({
    restaurantTrust: { chain: { chainId: CHAIN_A, name: "Synthetic Fixture Chain" } },
    claims: [certificationClaim({ subject: chainSubject, coverage: chainCoverage })],
    evidence: [certificateEvidence({ subject: chainSubject, coverage: chainCoverage })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.equal(result.chain.chainId, CHAIN_A);
  assert.equal(result.identity.placeId, PLACE_A);
  assert.equal(result.acceptedClaims[0].applicability, "CHAIN_ONLY");
  assert.match(result.whatWeDontKnow.join(" "), /chain-level claim/i);
});

test("partial menu certification remains visibly partial", () => {
  const itemCoverage = coverage("MENU_ITEM", { menuItemId: "synthetic-menu-item" });
  const result = contract({
    claims: [certificationClaim({ coverage: itemCoverage })],
    evidence: [certificateEvidence({ coverage: itemCoverage })],
  });
  assert.equal(result.summary.status, "PARTIAL_SUPPORT");
  assert.equal(result.summary.appliesToExactLocation, true);
  assert.equal(result.summary.isWholeLocation, false);
  assert.equal(result.summary.isPartial, true);
  assert.equal(result.coverage[0].kind, "MENU_ITEM");
  assert.equal(result.coverage[0].menuItemId, "synthetic-menu-item");
  assert.match(result.whatWeDontKnow.join(" "), /does not cover the entire/i);
});

test("meat-supplier evidence cannot become whole-location certification", () => {
  const meatCoverage = coverage("MEAT_SERVED");
  const claim = {
    id: "synthetic-claim-meat",
    type: "HALAL_MEAT_CLAIM",
    position: "AFFIRMS",
    subject: subject(),
    coverage: meatCoverage,
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-supplier"],
  };
  const evidence = {
    id: "synthetic-evidence-supplier",
    type: "SUPPLIER_DOCUMENT",
    subject: subject(),
    coverage: meatCoverage,
    issuer: { type: "SUPPLIER", id: "synthetic-supplier", name: "Synthetic Fixture Supplier" },
    sourceRef: "synthetic-supplier-record",
    reviewState: "ACCEPTED",
  };
  const result = contract({ claims: [claim], evidence: [evidence] });
  assert.equal(result.summary.status, "PARTIAL_SUPPORT");
  assert.notEqual(result.summary.status, "CERTIFIED");
  assert.equal(result.coverage[0].kind, "MEAT_SERVED");
});

test("owner/business confirmation remains distinct from certification", () => {
  const result = contract({ claims: [businessClaim()], evidence: [businessEvidence()] });
  assert.equal(result.summary.status, "BUSINESS_CONFIRMED");
  assert.equal(result.evidenceLevel, "BUSINESS_CONFIRMATION");
  assert.notEqual(result.summary.status, "CERTIFIED");
});

test("community reporting remains distinct from owner confirmation and certification", () => {
  const claim = {
    id: "synthetic-claim-community",
    type: "COMMUNITY_REPORT",
    position: "AFFIRMS",
    subject: subject(),
    coverage: entire(),
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-community"],
  };
  const evidence = {
    id: "synthetic-evidence-community",
    type: "COMMUNITY_REPORT",
    subject: subject(),
    coverage: entire(),
    issuer: { type: "COMMUNITY_MEMBER", id: "synthetic-community-member" },
    sourceRef: "synthetic-community-report",
    reviewState: "ACCEPTED",
  };
  const result = contract({ claims: [claim], evidence: [evidence] });
  assert.equal(result.summary.status, "COMMUNITY_REPORTED");
  assert.notEqual(result.summary.status, "BUSINESS_CONFIRMED");
  assert.notEqual(result.summary.status, "CERTIFIED");
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

for (const status of ["EXPIRED", "SUSPENDED", "REVOKED"]) {
  test(`${status} certification cannot support active certification`, () => {
    const result = contract({
      claims: [certificationClaim()],
      evidence: [certificateEvidence({ certification: { ...certificateEvidence().certification, status } })],
    });
    assert.equal(result.summary.status, "UNVERIFIED");
  });
}

test("past expiry blocks certification even when status says ACTIVE", () => {
  const result = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ certification: { ...certificateEvidence().certification, expiresAt: "2025-01-01T00:00:00.000Z" } })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("future claim, evidence, or certificate validity cannot become active early", () => {
  const future = "2027-01-01T00:00:00.000Z";
  const cases = [
    {
      claims: [certificationClaim({ effectiveFrom: future })],
      evidence: [certificateEvidence()],
    },
    {
      claims: [certificationClaim()],
      evidence: [certificateEvidence({ effectiveFrom: future })],
    },
    {
      claims: [certificationClaim()],
      evidence: [certificateEvidence({ certification: { ...certificateEvidence().certification, validFrom: future } })],
    },
  ];

  for (const value of cases) {
    assert.equal(contract(value).summary.status, "UNVERIFIED");
  }
});

test("unknown certification status is not treated as active", () => {
  const result = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ certification: { ...certificateEvidence().certification, status: "UNKNOWN" } })],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("missing evidence produces the safe unknown contract", () => {
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
    evidence: [certificateEvidence({ coverage: coverage("MENU_ITEM", { menuItemId: "other-item" }) })],
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
      coverage: { kind: "ENTIRE_LOCATION", target: "Synthetic Contract Kitchen" },
    }],
    evidence: [{
      ...certificateEvidence(),
      subject: undefined,
      coverage: { kind: "ENTIRE_LOCATION", target: "Synthetic Contract Kitchen" },
    }],
  });
  assert.equal(result.summary.status, "UNVERIFIED");
});

test("chain and exact location identities remain distinct", () => {
  const result = contract({
    restaurantTrust: { chain: { chainId: CHAIN_A, name: "Synthetic Fixture Chain" } },
    claims: [businessClaim()],
    evidence: [businessEvidence()],
  });
  assert.deepEqual(result.chain, { chainId: CHAIN_A, name: "Synthetic Fixture Chain" });
  assert.equal(result.identity.placeId, PLACE_A);
  assert.notEqual(result.chain.chainId, result.identity.placeId);
});

test("structured coverage survives normalization", () => {
  assert.deepEqual(normalizeCoverage({
    kind: "MENU_CATEGORY",
    placeId: PLACE_A,
    menuCategoryId: "synthetic-category",
    label: "Synthetic category label",
  }), {
    kind: "MENU_CATEGORY",
    placeId: PLACE_A,
    chainId: null,
    menuCategoryId: "synthetic-category",
    menuItemId: null,
    departmentId: null,
    supplierId: null,
    label: "Synthetic category label",
  });
});

test("raw legacy booleans and storage-only trust data never enter public projections", () => {
  const place = makePlace({ legacy: { halal: true, certified: true } });
  const list = buildRestaurantListProjection(place, { now: NOW });
  const detail = buildRestaurantDetailProjection(place, { now: NOW });
  for (const projection of [list, detail]) {
    assert.equal(Object.hasOwn(projection, "halal"), false);
    assert.equal(Object.hasOwn(projection, "certified"), false);
    assert.equal(Object.hasOwn(projection, "restaurantTrust"), false);
    assert.equal(projection.restaurantSummary.status, "UNVERIFIED");
  }
});

test("Open Food Facts/product provenance cannot become restaurant evidence", () => {
  const result = contract({
    claims: [certificationClaim()],
    evidence: [certificateEvidence({ type: "OPEN_FOOD_FACTS" })],
    restaurantTrust: { provenance: { recordSource: "OPEN_FOOD_FACTS", sourceRecordId: "synthetic-product-record" } },
  });
  assert.equal(result.summary.status, "UNVERIFIED");
  assert.equal(result.provenance.recordSource, "OPEN_FOOD_FACTS");
  assert.deepEqual(result.acceptedEvidence, []);
});

test("contradictory accepted exact-location claims degrade to UNVERIFIED", () => {
  const disputeClaim = {
    id: "synthetic-claim-dispute",
    type: "EXPERT_REVIEWED_FINDING",
    position: "DISPUTES",
    subject: subject(),
    coverage: entire(),
    reviewState: "ACCEPTED",
    evidenceRefs: ["synthetic-evidence-dispute"],
  };
  const disputeEvidence = {
    id: "synthetic-evidence-dispute",
    type: "EXPERT_REVIEW",
    subject: subject(),
    coverage: entire(),
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

test("supplier and slaughter records remain factual and do not create a halal status", () => {
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
      coverage: entire(),
      reviewState: "ACCEPTED",
      evidenceRefs: ["synthetic-negative-evidence"],
    }],
    evidence: [{
      id: "synthetic-negative-evidence",
      type: "EXPERT_REVIEW",
      subject: subject(),
      coverage: entire(),
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
    restaurantTrust: {
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
