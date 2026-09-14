"use strict";

const RESTAURANT_RESULT_CONTRACT_VERSION = 1;

const CLAIM_TYPES = Object.freeze([
  "INDEPENDENT_CERTIFICATION",
  "BUSINESS_CONFIRMATION",
  "HALAL_MEAT_CLAIM",
  "MENU_COVERAGE_CLAIM",
  "COMMUNITY_REPORT",
  "EXPERT_REVIEWED_FINDING",
  "SUPPLIER_RELATIONSHIP",
  "SLAUGHTER_METHOD_INFORMATION",
]);
const CLAIM_POSITIONS = Object.freeze(["AFFIRMS", "DISPUTES", "INFORMATIONAL"]);
const COVERAGE_KINDS = Object.freeze([
  "ENTIRE_LOCATION",
  "MEAT_SERVED",
  "MENU_CATEGORY",
  "MENU_ITEM",
  "DEPARTMENT_OR_COUNTER",
  "NAMED_SUPPLIER",
  "CHAIN_LEVEL_ONLY",
]);
const EVIDENCE_TYPES = Object.freeze([
  "CERTIFICATE",
  "BUSINESS_ATTESTATION",
  "COMMUNITY_REPORT",
  "EXPERT_REVIEW",
  "SUPPLIER_DOCUMENT",
  "SLAUGHTER_METHOD_DOCUMENT",
  "MENU_DOCUMENT",
  "OTHER_DOCUMENT",
]);
const REVIEW_STATES = Object.freeze(["ACCEPTED", "PENDING", "REJECTED", "UNREVIEWED"]);
const ISSUER_TYPES = Object.freeze([
  "CERTIFICATION_AUTHORITY",
  "BUSINESS",
  "OWNER",
  "COMMUNITY_MEMBER",
  "EXPERT",
  "SUPPLIER",
  "OTHER",
]);
const CERTIFICATION_STATUSES = Object.freeze(["ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED", "UNKNOWN"]);
const SUMMARY_STATUSES = Object.freeze([
  "CERTIFIED",
  "BUSINESS_CONFIRMED",
  "PARTIAL_SUPPORT",
  "COMMUNITY_REPORTED",
  "UNVERIFIED",
]);

const CLAIM_EVIDENCE_TYPES = Object.freeze({
  INDEPENDENT_CERTIFICATION: ["CERTIFICATE"],
  BUSINESS_CONFIRMATION: ["BUSINESS_ATTESTATION"],
  HALAL_MEAT_CLAIM: ["BUSINESS_ATTESTATION", "SUPPLIER_DOCUMENT", "EXPERT_REVIEW"],
  MENU_COVERAGE_CLAIM: ["CERTIFICATE", "BUSINESS_ATTESTATION", "MENU_DOCUMENT", "EXPERT_REVIEW"],
  COMMUNITY_REPORT: ["COMMUNITY_REPORT"],
  EXPERT_REVIEWED_FINDING: ["EXPERT_REVIEW"],
  SUPPLIER_RELATIONSHIP: ["SUPPLIER_DOCUMENT", "BUSINESS_ATTESTATION"],
  SLAUGHTER_METHOD_INFORMATION: ["SLAUGHTER_METHOD_DOCUMENT", "SUPPLIER_DOCUMENT", "EXPERT_REVIEW"],
});

const clean = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const cleanId = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const enumValue = (value, allowed, fallback) => {
  const normalized = String(value || "").trim().toUpperCase();
  return allowed.includes(normalized) ? normalized : fallback;
};
const cleanList = (value) => Array.isArray(value)
  ? [...new Set(value.map(clean).filter(Boolean))]
  : [];
const cleanIdList = (value) => Array.isArray(value)
  ? [...new Set(value.map(cleanId).filter(Boolean))]
  : [];
const cleanDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const toPlainObject = (value) => {
  if (!value || typeof value !== "object") return {};
  return typeof value.toObject === "function" ? value.toObject() : value;
};
const compactObject = (value) => Object.fromEntries(
  Object.entries(value).filter(([, entry]) => entry !== undefined)
);

function normalizeSubject(value) {
  const subject = value && typeof value === "object" ? value : {};
  return {
    placeId: cleanId(subject.placeId),
    chainId: cleanId(subject.chainId),
  };
}

function normalizeCoverage(value) {
  const coverage = value && typeof value === "object" ? value : {};
  return {
    kind: enumValue(coverage.kind, COVERAGE_KINDS, "UNKNOWN"),
    placeId: cleanId(coverage.placeId),
    chainId: cleanId(coverage.chainId),
    menuCategoryId: cleanId(coverage.menuCategoryId),
    menuItemId: cleanId(coverage.menuItemId),
    departmentId: cleanId(coverage.departmentId),
    supplierId: cleanId(coverage.supplierId),
    label: clean(coverage.label),
  };
}

function normalizeParty(value) {
  const party = value && typeof value === "object" ? value : {};
  return {
    type: enumValue(party.type, ISSUER_TYPES, "UNKNOWN"),
    id: cleanId(party.id),
    name: clean(party.name),
  };
}

function normalizeCertification(value) {
  if (!value || typeof value !== "object") return null;
  const certification = value;
  return {
    authorityName: clean(certification.authorityName),
    certificateId: clean(certification.certificateId),
    status: enumValue(certification.status, CERTIFICATION_STATUSES, "UNKNOWN"),
    validFrom: cleanDate(certification.validFrom),
    expiresAt: cleanDate(certification.expiresAt),
  };
}

function normalizeClaim(value) {
  const claim = value && typeof value === "object" ? value : {};
  return {
    id: cleanId(claim.id),
    type: enumValue(claim.type, CLAIM_TYPES, "UNKNOWN"),
    position: enumValue(claim.position, CLAIM_POSITIONS, "INFORMATIONAL"),
    subject: normalizeSubject(claim.subject),
    coverage: normalizeCoverage(claim.coverage),
    claimant: normalizeParty(claim.claimant),
    reviewState: enumValue(claim.reviewState, REVIEW_STATES, "UNREVIEWED"),
    reviewedBy: clean(claim.reviewedBy),
    evidenceRefs: cleanIdList(claim.evidenceRefs),
    effectiveFrom: cleanDate(claim.effectiveFrom),
    effectiveTo: cleanDate(claim.effectiveTo),
    checkedAt: cleanDate(claim.checkedAt),
    limitations: cleanList(claim.limitations),
  };
}

function normalizeEvidence(value) {
  const evidence = value && typeof value === "object" ? value : {};
  return {
    id: cleanId(evidence.id),
    type: enumValue(evidence.type, EVIDENCE_TYPES, "UNKNOWN"),
    subject: normalizeSubject(evidence.subject),
    coverage: normalizeCoverage(evidence.coverage),
    issuer: normalizeParty(evidence.issuer),
    sourceRef: clean(evidence.sourceRef),
    sourceUrl: clean(evidence.sourceUrl),
    reviewState: enumValue(evidence.reviewState, REVIEW_STATES, "UNREVIEWED"),
    reviewedBy: clean(evidence.reviewedBy),
    sourceDate: cleanDate(evidence.sourceDate),
    checkedAt: cleanDate(evidence.checkedAt),
    effectiveFrom: cleanDate(evidence.effectiveFrom),
    expiresAt: cleanDate(evidence.expiresAt),
    relatedClaimRefs: cleanIdList(evidence.relatedClaimRefs),
    limitations: cleanList(evidence.limitations),
    certification: normalizeCertification(evidence.certification),
  };
}

function markDuplicateIds(items) {
  const counts = new Map();
  items.forEach((item) => {
    if (item.id) counts.set(item.id, (counts.get(item.id) || 0) + 1);
  });
  return items.map((item) => counts.get(item.id) > 1
    ? { ...item, reviewState: "UNREVIEWED", integrity: "DUPLICATE_ID" }
    : { ...item, integrity: item.id ? "VALID_ID" : "MISSING_ID" });
}

function coverageIsValid(coverage) {
  if (!coverage || !COVERAGE_KINDS.includes(coverage.kind)) return false;
  switch (coverage.kind) {
    case "ENTIRE_LOCATION":
    case "MEAT_SERVED":
      return Boolean(coverage.placeId);
    case "MENU_CATEGORY":
      return Boolean(coverage.placeId && coverage.menuCategoryId);
    case "MENU_ITEM":
      return Boolean(coverage.placeId && coverage.menuItemId);
    case "DEPARTMENT_OR_COUNTER":
      return Boolean(coverage.placeId && coverage.departmentId);
    case "NAMED_SUPPLIER":
      return Boolean(coverage.placeId && coverage.supplierId);
    case "CHAIN_LEVEL_ONLY":
      return Boolean(coverage.chainId) && !coverage.placeId;
    default:
      return false;
  }
}

function subjectMatchesCoverage(subject, coverage) {
  if (!coverageIsValid(coverage)) return false;
  if (coverage.kind === "CHAIN_LEVEL_ONLY") {
    return Boolean(subject.chainId && subject.chainId === coverage.chainId && !subject.placeId);
  }
  return Boolean(subject.placeId && subject.placeId === coverage.placeId);
}

function appliesToExactPlace(subject, coverage, placeId) {
  return Boolean(
    placeId &&
    coverage.kind !== "CHAIN_LEVEL_ONLY" &&
    subject.placeId === placeId &&
    coverage.placeId === placeId
  );
}

function coverageKey(coverage) {
  return [
    coverage.kind,
    coverage.placeId,
    coverage.chainId,
    coverage.menuCategoryId,
    coverage.menuItemId,
    coverage.departmentId,
    coverage.supplierId,
  ].map((value) => value || "").join("|");
}

function sameCoverage(left, right) {
  return coverageKey(left) === coverageKey(right);
}

function evidenceHasProvenance(evidence) {
  if (evidence.type === "CERTIFICATE") {
    return Boolean(
      evidence.certification &&
      evidence.issuer.type === "CERTIFICATION_AUTHORITY" &&
      evidence.issuer.name &&
      evidence.certification.authorityName &&
      evidence.issuer.name === evidence.certification.authorityName &&
      (evidence.sourceRef || evidence.sourceUrl || evidence.certification.certificateId)
    );
  }
  return Boolean(evidence.sourceRef || evidence.sourceUrl || evidence.issuer.name || evidence.issuer.id);
}

function isPast(value, nowMs) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed < nowMs;
}

function isFuture(value, nowMs) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && parsed > nowMs;
}

function evidenceIsEligible(evidence, nowMs) {
  if (!evidence.id || evidence.integrity !== "VALID_ID") return false;
  if (evidence.reviewState !== "ACCEPTED" || evidence.type === "UNKNOWN") return false;
  if (!subjectMatchesCoverage(evidence.subject, evidence.coverage)) return false;
  if (!evidenceHasProvenance(evidence)) return false;
  if (isFuture(evidence.effectiveFrom, nowMs)) return false;
  if (isPast(evidence.expiresAt, nowMs)) return false;
  if (evidence.type === "CERTIFICATE") {
    if (!evidence.certification) return false;
    if (evidence.certification.status !== "ACTIVE") return false;
    if (isFuture(evidence.certification.validFrom, nowMs)) return false;
    if (isPast(evidence.certification.expiresAt, nowMs)) return false;
  }
  return true;
}

function claimIsCurrent(claim, nowMs) {
  return !isFuture(claim.effectiveFrom, nowMs) && !isPast(claim.effectiveTo, nowMs);
}

function claimHasRequiredClaimant(claim) {
  if (claim.type !== "BUSINESS_CONFIRMATION") return true;
  return ["BUSINESS", "OWNER"].includes(claim.claimant.type) && Boolean(claim.claimant.name || claim.claimant.id);
}

function evidenceSupportsClaim(evidence, claim) {
  const allowedTypes = CLAIM_EVIDENCE_TYPES[claim.type] || [];
  if (!allowedTypes.includes(evidence.type)) return false;
  if (!sameCoverage(evidence.coverage, claim.coverage)) return false;
  if (claim.coverage.kind === "CHAIN_LEVEL_ONLY") {
    return evidence.subject.chainId === claim.subject.chainId && !evidence.subject.placeId;
  }
  return evidence.subject.placeId === claim.subject.placeId;
}

function buildAcceptedClaims(claims, evidenceById, placeId, nowMs) {
  return claims.flatMap((claim) => {
    if (!claim.id || claim.integrity !== "VALID_ID" || claim.type === "UNKNOWN") return [];
    if (claim.reviewState !== "ACCEPTED" || !claimIsCurrent(claim, nowMs)) return [];
    if (!claimHasRequiredClaimant(claim) || !subjectMatchesCoverage(claim.subject, claim.coverage)) return [];
    if (!claim.evidenceRefs.length) return [];

    const supportingEvidence = claim.evidenceRefs.map((id) => evidenceById.get(id));
    if (supportingEvidence.some((entry) => !entry || !evidenceIsEligible(entry, nowMs))) return [];
    if (supportingEvidence.some((entry) => !evidenceSupportsClaim(entry, claim))) return [];

    const appliesToLocation = appliesToExactPlace(claim.subject, claim.coverage, placeId);
    const applicability = claim.coverage.kind === "CHAIN_LEVEL_ONLY"
      ? "CHAIN_ONLY"
      : appliesToLocation
        ? "EXACT_LOCATION"
        : "OTHER_LOCATION";
    if (applicability === "OTHER_LOCATION") return [];

    return [{
      ...claim,
      appliesToExactLocation: appliesToLocation,
      applicability,
    }];
  });
}

function uniqueCoverages(claims) {
  const seen = new Set();
  return claims.flatMap((claim) => {
    const key = coverageKey(claim.coverage);
    if (seen.has(key)) return [];
    seen.add(key);
    return [claim.coverage];
  });
}

function acceptedEvidenceForClaims(claims, evidenceById) {
  const ids = new Set(claims.flatMap((claim) => claim.evidenceRefs));
  return [...ids].map((id) => evidenceById.get(id)).filter(Boolean);
}

function certificateForClaim(claim, evidenceById) {
  if (!claim || claim.type !== "INDEPENDENT_CERTIFICATION") return null;
  return claim.evidenceRefs
    .map((id) => evidenceById.get(id))
    .find((evidence) => evidence?.type === "CERTIFICATE") || null;
}

function buildSummary(acceptedClaims, evidenceById, placeId) {
  const exact = acceptedClaims.filter((claim) => claim.appliesToExactLocation);
  const affirming = exact.filter((claim) => claim.position === "AFFIRMS");
  const disputes = exact.filter((claim) => claim.position === "DISPUTES");
  const hasConflict = affirming.length > 0 && disputes.length > 0;
  let status = "UNVERIFIED";
  let evidenceLevel = "UNVERIFIED";
  let statement = "No accepted evidence establishes a supported halal status for this exact location.";
  let supportingClaimIds = [];

  if (!hasConflict) {
    const certified = affirming.find((claim) =>
      claim.type === "INDEPENDENT_CERTIFICATION" && claim.coverage.kind === "ENTIRE_LOCATION" &&
      certificateForClaim(claim, evidenceById)
    );
    const confirmed = affirming.find((claim) =>
      claim.type === "BUSINESS_CONFIRMATION" && claim.coverage.kind === "ENTIRE_LOCATION"
    );
    const partial = affirming.filter((claim) =>
      ["INDEPENDENT_CERTIFICATION", "BUSINESS_CONFIRMATION", "HALAL_MEAT_CLAIM", "MENU_COVERAGE_CLAIM"].includes(claim.type) &&
      claim.coverage.kind !== "ENTIRE_LOCATION"
    );
    const community = affirming.filter((claim) => claim.type === "COMMUNITY_REPORT");

    if (certified) {
      status = "CERTIFIED";
      evidenceLevel = "INDEPENDENT_CERTIFICATION";
      statement = "Independent certification evidence applies to this exact restaurant location.";
      supportingClaimIds = [certified.id];
    } else if (confirmed) {
      status = "BUSINESS_CONFIRMED";
      evidenceLevel = "BUSINESS_CONFIRMATION";
      statement = "An accepted owner or business confirmation applies to this exact restaurant location.";
      supportingClaimIds = [confirmed.id];
    } else if (partial.length) {
      status = "PARTIAL_SUPPORT";
      evidenceLevel = "PARTIAL_EVIDENCE";
      statement = "Accepted evidence applies only to the specified coverage at this restaurant location.";
      supportingClaimIds = partial.map((claim) => claim.id);
    } else if (community.length) {
      status = "COMMUNITY_REPORTED";
      evidenceLevel = "COMMUNITY_REPORT";
      statement = "An accepted community report exists for this location; it is not certification or owner confirmation.";
      supportingClaimIds = community.map((claim) => claim.id);
    }
  }

  const summaryClaims = supportingClaimIds.length
    ? acceptedClaims.filter((claim) => supportingClaimIds.includes(claim.id))
    : acceptedClaims.filter((claim) => claim.position !== "INFORMATIONAL");

  return {
    status,
    label: {
      CERTIFIED: "Certified location",
      BUSINESS_CONFIRMED: "Business confirmed",
      PARTIAL_SUPPORT: "Partial coverage",
      COMMUNITY_REPORTED: "Community reported",
      UNVERIFIED: "Unverified",
    }[status],
    placeId,
    appliesToExactLocation: status !== "UNVERIFIED",
    isWholeLocation: ["CERTIFIED", "BUSINESS_CONFIRMED"].includes(status),
    isPartial: status === "PARTIAL_SUPPORT",
    evidenceLevel,
    statement,
    coverage: uniqueCoverages(summaryClaims),
    supportingClaimIds,
  };
}

function normalizeKnownFacts(value, acceptedClaims, acceptedEvidence) {
  const claimIds = new Set(acceptedClaims.map((claim) => claim.id));
  const evidenceIds = new Set(acceptedEvidence.map((evidence) => evidence.id));
  return (Array.isArray(value) ? value : []).flatMap((raw) => {
    const fact = raw && typeof raw === "object" ? raw : {};
    const text = clean(fact.text);
    const claimRefs = cleanIdList(fact.claimRefs);
    const evidenceRefs = cleanIdList(fact.evidenceRefs);
    const valid = text && claimRefs.length && evidenceRefs.length &&
      claimRefs.every((id) => claimIds.has(id)) && evidenceRefs.every((id) => evidenceIds.has(id));
    return valid ? [{ id: cleanId(fact.id), text, claimRefs, evidenceRefs }] : [];
  });
}

function latestCheckedAt(raw, acceptedClaims, acceptedEvidence) {
  const candidates = [
    cleanDate(raw.checkedAt),
    ...acceptedClaims.map((claim) => claim.checkedAt),
    ...acceptedEvidence.map((evidence) => evidence.checkedAt),
  ].filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

function placeIdentity(place) {
  const placeId = cleanId(place._id || place.id);
  const coords = place.coords && Number.isFinite(place.coords.lat) && Number.isFinite(place.coords.lng) &&
    Math.abs(place.coords.lat) <= 90 && Math.abs(place.coords.lng) <= 180
    ? { lat: place.coords.lat, lng: place.coords.lng }
    : null;
  return {
    placeId,
    name: clean(place.name),
    address: clean(place.address),
    city: clean(place.city),
    state: clean(place.state),
    postcode: clean(place.postcode),
    coords,
  };
}

function buildRestaurantResultContract(value, { now = new Date() } = {}) {
  const place = toPlainObject(value);
  const raw = place.restaurantTrust && typeof place.restaurantTrust === "object" ? place.restaurantTrust : {};
  const identity = placeIdentity(place);
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = Number.isNaN(nowDate.getTime()) ? Date.now() : nowDate.getTime();
  const evidence = markDuplicateIds((Array.isArray(raw.evidence) ? raw.evidence : []).map(normalizeEvidence));
  const claims = markDuplicateIds((Array.isArray(raw.claims) ? raw.claims : []).map(normalizeClaim));
  const evidenceById = new Map(evidence.filter((item) => item.id && item.integrity === "VALID_ID").map((item) => [item.id, item]));
  const acceptedClaims = buildAcceptedClaims(claims, evidenceById, identity.placeId, nowMs);
  const acceptedEvidence = acceptedEvidenceForClaims(acceptedClaims, evidenceById);
  const summary = buildSummary(acceptedClaims, evidenceById, identity.placeId);
  const whatWeKnow = normalizeKnownFacts(raw.known, acceptedClaims, acceptedEvidence);
  const whatWeDontKnow = cleanList(raw.unknowns);
  const limitations = cleanList(raw.limitations);

  if (summary.status === "UNVERIFIED") {
    whatWeDontKnow.push("No accepted claim establishes halal coverage for this exact restaurant location.");
  }
  if (acceptedClaims.some((claim) => claim.applicability === "CHAIN_ONLY")) {
    whatWeDontKnow.push("A chain-level claim has not been established for this exact restaurant location.");
  }
  if (summary.isPartial) {
    whatWeDontKnow.push("Accepted evidence does not cover the entire restaurant location.");
  }
  const exactClaims = acceptedClaims.filter((claim) => claim.appliesToExactLocation);
  if (exactClaims.some((claim) => claim.position === "AFFIRMS") && exactClaims.some((claim) => claim.position === "DISPUTES")) {
    limitations.push("Accepted evidence contains conflicting claims for this restaurant location; no authoritative summary was selected.");
  }
  if (claims.some((claim) => claim.integrity !== "VALID_ID") || evidence.some((item) => item.integrity !== "VALID_ID")) {
    limitations.push("Duplicate or missing claim/evidence identifiers were excluded from authoritative results.");
  }
  if (claims.some((claim) => claim.reviewState === "ACCEPTED" && !acceptedClaims.some((accepted) => accepted.id === claim.id))) {
    limitations.push("One or more accepted-looking claims lacked valid, matching evidence and were excluded.");
  }

  const chain = raw.chain && typeof raw.chain === "object"
    ? { chainId: cleanId(raw.chain.chainId), name: clean(raw.chain.name) }
    : { chainId: null, name: null };
  const provenanceRaw = raw.provenance && typeof raw.provenance === "object" ? raw.provenance : {};

  const stripIntegrity = ({ integrity, ...item }) => item;

  return {
    contractVersion: RESTAURANT_RESULT_CONTRACT_VERSION,
    identity,
    chain,
    summary,
    coverage: summary.coverage,
    evidenceLevel: summary.evidenceLevel,
    acceptedClaims: acceptedClaims.map(stripIntegrity),
    acceptedEvidence: acceptedEvidence.map(stripIntegrity),
    whatWeKnow,
    whatWeDontKnow: [...new Set(whatWeDontKnow)],
    limitations: [...new Set([
      ...limitations,
      ...acceptedClaims.flatMap((claim) => claim.limitations),
      ...acceptedEvidence.flatMap((item) => item.limitations),
    ])],
    checkedAt: latestCheckedAt(raw, acceptedClaims, acceptedEvidence),
    reviewedAt: cleanDate(raw.reviewedAt),
    nextActions: cleanList(raw.nextActions),
    provenance: {
      recordSource: clean(provenanceRaw.recordSource),
      sourceRecordId: cleanId(provenanceRaw.sourceRecordId),
      sourceUrl: clean(provenanceRaw.sourceUrl),
    },
  };
}

function compatibilityTrust(contract) {
  const summary = contract.summary;
  const certificationEvidence = summary.status === "CERTIFIED"
    ? contract.acceptedEvidence.find((item) => item.type === "CERTIFICATE")
    : null;
  return {
    version: 1,
    entityType: "PLACE",
    verdict: "UNKNOWN",
    reason: summary.statement,
    evidenceLevel: summary.status === "CERTIFIED"
      ? "CERTIFIED"
      : summary.status === "BUSINESS_CONFIRMED"
        ? "CONFIRMED"
        : summary.status === "COMMUNITY_REPORTED"
          ? "COMMUNITY_REPORTED"
          : "UNVERIFIED",
    certification: certificationEvidence ? {
      evidenceId: certificationEvidence.id,
      authorityName: certificationEvidence.certification.authorityName,
      certificateId: certificationEvidence.certification.certificateId,
      scope: { kind: "BUSINESS", target: contract.identity.placeId },
      target: contract.identity.placeId,
      validFrom: certificationEvidence.certification.validFrom,
      expiresAt: certificationEvidence.certification.expiresAt,
      status: certificationEvidence.certification.status,
      sourceUrl: certificationEvidence.sourceUrl,
      sourceDate: certificationEvidence.sourceDate,
      checkedAt: certificationEvidence.checkedAt,
    } : null,
    evidence: [],
    verified: [],
    unverified: [],
    unknowns: contract.whatWeDontKnow,
    nextActions: contract.nextActions,
    checkedAt: contract.checkedAt,
  };
}

function safeRestaurantListing(value) {
  const place = toPlainObject(value);
  const identity = placeIdentity(place);
  const result = compactObject({
    _id: identity.placeId || undefined,
    id: identity.placeId || undefined,
    type: "restaurant",
    name: identity.name || undefined,
    cuisine: clean(place.cuisine) || undefined,
    tags: Array.isArray(place.tags) ? cleanList(place.tags) : undefined,
    address: identity.address || undefined,
    city: identity.city || undefined,
    state: identity.state || undefined,
    postcode: identity.postcode || undefined,
    price: Number.isFinite(place.price) ? place.price : undefined,
    rating: Number.isFinite(place.rating) ? place.rating : undefined,
    phone: clean(place.phone) || undefined,
    website: clean(place.website) || undefined,
    photos: Array.isArray(place.photos) ? cleanList(place.photos) : undefined,
    hours: Array.isArray(place.hours) ? place.hours : undefined,
    hours_raw: place.hours_raw !== undefined ? place.hours_raw : undefined,
    coords: identity.coords || undefined,
    distance: Number.isFinite(place.distance) ? place.distance : undefined,
  });
  return result;
}

function buildRestaurantListProjection(value, options) {
  const contract = buildRestaurantResultContract(value, options);
  return {
    ...safeRestaurantListing(value),
    restaurantSummary: contract.summary,
    trust: compatibilityTrust(contract),
  };
}

function buildRestaurantDetailProjection(value, options) {
  const contract = buildRestaurantResultContract(value, options);
  const listing = safeRestaurantListing(value);
  return {
    _id: listing._id,
    id: listing.id,
    type: listing.type,
    name: listing.name,
    cuisine: listing.cuisine,
    tags: listing.tags,
    address: listing.address,
    city: listing.city,
    state: listing.state,
    postcode: listing.postcode,
    phone: listing.phone,
    website: listing.website,
    coords: listing.coords,
    restaurantSummary: contract.summary,
    restaurantResult: contract,
  };
}

module.exports = {
  RESTAURANT_RESULT_CONTRACT_VERSION,
  CLAIM_TYPES,
  CLAIM_POSITIONS,
  COVERAGE_KINDS,
  EVIDENCE_TYPES,
  REVIEW_STATES,
  ISSUER_TYPES,
  CERTIFICATION_STATUSES,
  SUMMARY_STATUSES,
  normalizeSubject,
  normalizeCoverage,
  normalizeClaim,
  normalizeEvidence,
  buildRestaurantResultContract,
  buildRestaurantListProjection,
  buildRestaurantDetailProjection,
};
