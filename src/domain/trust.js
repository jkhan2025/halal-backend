"use strict";

const PRODUCT_RESULT_CONTRACT_VERSION = 1;
const PRODUCT_HISTORY_CONTRACT_VERSION = 1;
const VERDICTS = Object.freeze(["HALAL", "HARAM", "NEEDS_REVIEW", "UNKNOWN"]);
const EVIDENCE_TYPES = Object.freeze([
  "CERTIFIED", "MANUFACTURER_CONFIRMED", "BUSINESS_CONFIRMED", "EXPERT_REVIEWED",
  "INGREDIENT_ANALYSIS", "COMMUNITY_REPORTED", "UNVERIFIED",
]);
const REVIEW_STATES = Object.freeze(["ACCEPTED", "PENDING", "REJECTED", "UNREVIEWED"]);
const SCOPE_KINDS = Object.freeze([
  "PRODUCT", "SKU", "FORMULATION", "BRAND", "BUSINESS", "DEPARTMENT",
  "PRODUCT_SELECTION", "INGREDIENT", "UNKNOWN",
]);
const SOURCE_STATES = Object.freeze([
  "VERIFIED_PRODUCT_SPECIFIC", "MANUFACTURER_CONFIRMED", "CERTIFICATION_SUPPORTED",
  "OTHER_SUPPORTED", "UNKNOWN",
]);
const FACTOR_ROLES = Object.freeze(["DECISIVE", "SUPPORTING", "UNRESOLVED"]);
const MATCH_STATES = Object.freeze(["EXACT_PRODUCT", "INGREDIENT_ONLY", "UNVERIFIED"]);
const OBSERVATION_SOURCE_TYPES = Object.freeze([
  "PACKAGE_LABEL", "INGREDIENT_IMAGE", "MANUFACTURER_DATA", "PROVIDER_IMPORT", "OTHER", "UNKNOWN",
]);
const EXTRACTION_METHODS = Object.freeze(["MANUAL", "OCR", "PROVIDER_IMPORT", "OTHER", "UNKNOWN"]);
const CERTIFICATION_STATUSES = Object.freeze(["ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED", "UNKNOWN"]);
const RECORD_SOURCE_KINDS = Object.freeze(["LOCAL", "OPEN_FOOD_FACTS", "UNKNOWN"]);

const clean = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const cleanDate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};
const cleanTimestamp = cleanDate;
const cleanList = (value) => Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))] : [];
const allowed = (value, values, fallback) => {
  const normalized = String(value || "").toUpperCase();
  return values.includes(normalized) ? normalized : fallback;
};

function normalizeScope(value) {
  const scope = value && typeof value === "object" ? value : {};
  return {
    kind: allowed(scope.kind, SCOPE_KINDS, "UNKNOWN"),
    target: clean(scope.target),
    region: clean(scope.region),
    formulation: clean(scope.formulation),
    notes: clean(scope.notes),
  };
}

function normalizeEvidence(value, index = 0) {
  const item = value && typeof value === "object" ? value : {};
  return {
    id: clean(item.id),
    type: allowed(item.type, EVIDENCE_TYPES, "UNVERIFIED"),
    reviewState: allowed(item.reviewState, REVIEW_STATES, "UNREVIEWED"),
    title: clean(item.title),
    authorityName: clean(item.authorityName),
    publisher: clean(item.publisher),
    sourceUrl: clean(item.sourceUrl),
    sourceDate: cleanDate(item.sourceDate),
    checkedAt: cleanDate(item.checkedAt),
    scope: normalizeScope(item.scope),
    notes: clean(item.notes),
    certificateId: clean(item.certificateId),
    validFrom: cleanDate(item.validFrom),
    expiresAt: cleanDate(item.expiresAt),
    certificationStatus: item.certificationStatus ? allowed(item.certificationStatus, CERTIFICATION_STATUSES, "UNKNOWN") : null,
    position: index,
  };
}

function normalizeEvidenceList(value) {
  const evidence = Array.isArray(value) ? value.map(normalizeEvidence) : [];
  const counts = new Map();
  evidence.forEach((item) => {
    if (item.id) counts.set(item.id, (counts.get(item.id) || 0) + 1);
  });
  return evidence.map((item) => item.id && counts.get(item.id) > 1 ? { ...item, reviewState: "UNREVIEWED" } : item);
}

function normalizeProductSpecificSource(value) {
  const source = value && typeof value === "object" ? value : {};
  const state = allowed(source.state, SOURCE_STATES, "UNKNOWN");
  const evidenceRefs = cleanList(source.evidenceRefs);
  const supported = state !== "UNKNOWN" && evidenceRefs.length > 0;
  return {
    state: supported ? state : "UNKNOWN",
    value: supported ? clean(source.value) : null,
    evidenceRefs: supported ? evidenceRefs : [],
    notes: clean(source.notes),
  };
}

function normalizeFactor(value, index = 0) {
  const item = value && typeof value === "object" ? value : {};
  return {
    id: clean(item.id),
    role: allowed(item.role, FACTOR_ROLES, "SUPPORTING"),
    kind: clean(item.kind) || "OTHER",
    label: clean(item.label),
    finding: clean(item.finding),
    purpose: clean(item.purpose),
    whyItMatters: clean(item.whyItMatters),
    status: allowed(item.status, ["CONFIRMED", "POSSIBLE", "UNKNOWN"], "UNKNOWN"),
    evidenceRefs: cleanList(item.evidenceRefs),
    observedIngredientRefs: cleanList(item.observedIngredientRefs),
    generalKnowledge: cleanList(item.generalKnowledge),
    possibleSources: cleanList(item.possibleSources),
    productSpecificSource: normalizeProductSpecificSource(item.productSpecificSource),
    position: index,
  };
}

function normalizeObservedIngredient(value, index = 0) {
  const item = value && typeof value === "object" ? value : {};
  return {
    id: clean(item.id),
    rawText: clean(item.rawText),
    normalizedName: clean(item.normalizedName),
    additiveCode: clean(item.additiveCode),
    position: Number.isInteger(item.position) && item.position >= 0 ? item.position : null,
    sourceType: allowed(item.sourceType, OBSERVATION_SOURCE_TYPES, "UNKNOWN"),
    ingredientsImageRef: clean(item.ingredientsImageRef),
    extractionMethod: allowed(item.extractionMethod, EXTRACTION_METHODS, "UNKNOWN"),
    reviewState: allowed(item.reviewState, REVIEW_STATES, "UNREVIEWED"),
    evidenceRefs: cleanList(item.evidenceRefs),
    sequence: index,
  };
}

function normalizeObservedIngredients(value) {
  const observations = Array.isArray(value)
    ? value.map(normalizeObservedIngredient).filter((item) => item.id && (item.rawText || item.normalizedName || item.additiveCode))
    : [];
  const counts = new Map();
  observations.forEach((item) => counts.set(item.id, (counts.get(item.id) || 0) + 1));
  return observations.map((item) => counts.get(item.id) > 1 ? { ...item, reviewState: "UNREVIEWED" } : item);
}

const acceptedEvidence = (evidence) => evidence.filter((item) => item.reviewState === "ACCEPTED");
const hasTraceableProvenance = (item) => Boolean(item.id && (item.authorityName || item.publisher || item.title || item.sourceUrl));
function hasTypeAppropriateProvenance(item) {
  if (!hasTraceableProvenance(item)) return false;
  if (item.type === "CERTIFIED" || item.type === "EXPERT_REVIEWED") return Boolean(item.authorityName);
  if (["MANUFACTURER_CONFIRMED", "BUSINESS_CONFIRMED"].includes(item.type)) return Boolean(item.publisher || item.authorityName);
  return true;
}
function scopeSupportsEntity(scope, entityType) {
  const productScopes = ["PRODUCT", "SKU", "FORMULATION"];
  const placeScopes = ["BUSINESS", "DEPARTMENT", "PRODUCT_SELECTION"];
  return entityType === "PRODUCT"
    ? productScopes.includes(scope.kind) && Boolean(scope.target)
    : placeScopes.includes(scope.kind) && Boolean(scope.target);
}
function certificationIsUsable(item) {
  if (["EXPIRED", "SUSPENDED", "REVOKED"].includes(item.certificationStatus)) return false;
  if (item.expiresAt) {
    const expiry = Date.parse(item.expiresAt);
    if (!Number.isNaN(expiry) && expiry < Date.now()) return false;
  }
  return true;
}
function certificationFromEvidence(evidence, entityType) {
  const item = evidence.find((entry) =>
    entry.type === "CERTIFIED" && entry.reviewState === "ACCEPTED" &&
    hasTraceableProvenance(entry) && Boolean(entry.authorityName) &&
    scopeSupportsEntity(entry.scope, entityType) && certificationIsUsable(entry)
  );
  if (!item) return null;
  return {
    evidenceId: item.id,
    authorityName: item.authorityName,
    certificateId: item.certificateId,
    scope: item.scope,
    target: item.scope.target,
    region: item.scope.region,
    formulation: item.scope.formulation,
    validFrom: item.validFrom,
    expiresAt: item.expiresAt,
    status: item.certificationStatus,
    sourceUrl: item.sourceUrl,
    sourceDate: item.sourceDate,
    checkedAt: item.checkedAt,
  };
}
function acceptedEvidenceIds(evidence, entityType) {
  return new Set(acceptedEvidence(evidence)
    .filter((item) => scopeSupportsEntity(item.scope, entityType) && hasTypeAppropriateProvenance(item))
    .map((item) => item.id).filter(Boolean));
}
function supportedObservationIds(observations, evidenceIds) {
  return new Set(observations
    .filter((item) => item.reviewState === "ACCEPTED" && item.evidenceRefs.some((id) => evidenceIds.has(id)))
    .map((item) => item.id));
}
const isIngredientFactor = (factor) => /INGREDIENT|ADDITIVE/i.test(factor.kind || "");
function hasSupportedDecisiveFactor(factors, evidenceIds, observationIds) {
  return factors.some((factor) => {
    const source = factor.productSpecificSource;
    const sourceSupported = source.state !== "UNKNOWN" && source.evidenceRefs.some((id) => evidenceIds.has(id));
    const factorSupported = factor.evidenceRefs.some((id) => evidenceIds.has(id)) || sourceSupported;
    const observationSupported = !isIngredientFactor(factor) || factor.observedIngredientRefs.some((id) => observationIds.has(id));
    return factor.role === "DECISIVE" && factor.status === "CONFIRMED" && sourceSupported && factorSupported && observationSupported;
  });
}

function deriveMatchState(requestedValue, evidence, entityType) {
  if (entityType !== "PRODUCT") return { state: "UNVERIFIED", contradictory: false };
  const requested = allowed(requestedValue, MATCH_STATES, "UNVERIFIED");
  const accepted = acceptedEvidence(evidence).filter(hasTypeAppropriateProvenance);
  const hasExactEvidence = accepted.some((item) =>
    scopeSupportsEntity(item.scope, "PRODUCT") &&
    ["CERTIFIED", "MANUFACTURER_CONFIRMED", "EXPERT_REVIEWED"].includes(item.type) &&
    (item.type !== "CERTIFIED" || certificationIsUsable(item))
  );
  const hasIngredientAnalysis = accepted.some((item) =>
    item.type === "INGREDIENT_ANALYSIS" && scopeSupportsEntity(item.scope, "PRODUCT")
  );
  const derived = hasExactEvidence ? "EXACT_PRODUCT" : hasIngredientAnalysis ? "INGREDIENT_ONLY" : "UNVERIFIED";
  if (requested === "UNVERIFIED" || requested === derived) return { state: derived, contradictory: false };
  if (requested === "INGREDIENT_ONLY" && derived === "EXACT_PRODUCT") return { state: "UNVERIFIED", contradictory: true };
  return { state: derived, contradictory: true };
}

function supportsVerdict(verdict, entityType, evidence, factors, observations, matchState) {
  if (!["HALAL", "HARAM"].includes(verdict)) return true;
  const accepted = acceptedEvidence(evidence).filter((item) => scopeSupportsEntity(item.scope, entityType) && hasTypeAppropriateProvenance(item));
  const acceptedIds = new Set(accepted.map((item) => item.id).filter(Boolean));
  if (entityType === "PLACE") {
    if (verdict === "HALAL") return certificationFromEvidence(evidence, entityType)?.scope?.kind === "BUSINESS";
    return accepted.some((item) => item.type === "EXPERT_REVIEWED");
  }
  if (verdict === "HALAL") {
    return matchState === "EXACT_PRODUCT" && accepted.some((item) =>
      ["CERTIFIED", "MANUFACTURER_CONFIRMED", "EXPERT_REVIEWED"].includes(item.type) &&
      (item.type !== "CERTIFIED" || certificationIsUsable(item))
    );
  }
  const hasReview = accepted.some((item) =>
    ["CERTIFIED", "MANUFACTURER_CONFIRMED", "EXPERT_REVIEWED", "INGREDIENT_ANALYSIS"].includes(item.type)
  );
  return hasReview && hasSupportedDecisiveFactor(factors, acceptedIds, supportedObservationIds(observations, acceptedIds));
}

function evidenceLevel(evidence, entityType) {
  if (certificationFromEvidence(evidence, entityType)) return "CERTIFIED";
  const accepted = acceptedEvidence(evidence).filter(hasTypeAppropriateProvenance);
  if (accepted.some((item) => ["MANUFACTURER_CONFIRMED", "BUSINESS_CONFIRMED"].includes(item.type))) return "CONFIRMED";
  if (accepted.some((item) => item.type === "EXPERT_REVIEWED")) return "EXPERT_REVIEWED";
  if (accepted.some((item) => item.type === "INGREDIENT_ANALYSIS")) return "INGREDIENT_ANALYSIS";
  if (evidence.some((item) => item.type === "COMMUNITY_REPORTED")) return "COMMUNITY_REPORTED";
  return "UNVERIFIED";
}
function normalizeFactList(value, acceptedIds) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") return null;
    const text = clean(item.text);
    const evidenceRefs = cleanList(item.evidenceRefs).filter((id) => acceptedIds.has(id));
    return text && evidenceRefs.length ? { id: clean(item.id), text, evidenceRefs } : null;
  }).filter(Boolean);
}
function normalizeExplanation(value, acceptedIds, factorIds) {
  const item = value && typeof value === "object" ? value : {};
  const summary = clean(item.summary);
  const evidenceRefs = cleanList(item.evidenceRefs).filter((id) => acceptedIds.has(id));
  const factorRefs = cleanList(item.factorRefs).filter((id) => factorIds.has(id));
  const reviewState = allowed(item.reviewState, REVIEW_STATES, "UNREVIEWED");
  if (!summary || reviewState !== "ACCEPTED" || !evidenceRefs.length) return null;
  return {
    summary,
    details: clean(item.details),
    evidenceRefs,
    factorRefs,
    reviewState,
    version: Number.isInteger(item.version) && item.version > 0 ? item.version : 1,
    reviewedAt: cleanDate(item.reviewedAt),
    reviewedBy: clean(item.reviewedBy),
  };
}
function normalizeScholarlyList(value, acceptedExpertIds, factorIds, observationIds) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (!item || typeof item !== "object") return null;
    const text = clean(item.text || item.position);
    const evidenceRefs = cleanList(item.evidenceRefs).filter((id) => acceptedExpertIds.has(id));
    const reviewState = allowed(item.reviewState, REVIEW_STATES, "UNREVIEWED");
    if (!text || !evidenceRefs.length || reviewState !== "ACCEPTED") return null;
    return {
      id: clean(item.id), school: clean(item.school), authorityName: clean(item.authorityName),
      position: clean(item.position) || text, text,
      conditions: cleanList(item.conditions), exceptions: cleanList(item.exceptions),
      applicability: clean(item.applicability),
      factorRefs: cleanList(item.factorRefs).filter((id) => factorIds.has(id)),
      observedIngredientRefs: cleanList(item.observedIngredientRefs).filter((id) => observationIds.has(id)),
      evidenceRefs, reviewState,
      version: Number.isInteger(item.version) && item.version > 0 ? item.version : 1,
      publishedAt: cleanDate(item.publishedAt), reviewedAt: cleanDate(item.reviewedAt),
    };
  }).filter(Boolean);
}
function hasMeaningfulUnresolvedIssue(factors, unknowns, unverified) {
  return factors.some((factor) => factor.role === "UNRESOLVED" && Boolean(factor.label || factor.finding || factor.whyItMatters)) ||
    unknowns.length > 0 || unverified.length > 0;
}

function uniqueIds(items) {
  const counts = new Map();
  items.forEach((item) => {
    if (item.id) counts.set(item.id, (counts.get(item.id) || 0) + 1);
  });
  return new Set([...counts].filter(([, count]) => count === 1).map(([id]) => id));
}

function normalizeTrust(value, { entityType = "PRODUCT", legacy = {} } = {}) {
  const input = value && typeof value === "object" ? value : {};
  const evidence = normalizeEvidenceList(input.evidence);
  const knownEvidenceIds = new Set(evidence.map((item) => item.id).filter(Boolean));
  const rawObservations = normalizeObservedIngredients(input.observedIngredients);
  const observationIds = uniqueIds(rawObservations);
  const observedIngredients = rawObservations.map((item) => ({
    ...item,
    evidenceRefs: item.evidenceRefs.filter((id) => knownEvidenceIds.has(id)),
  }));
  const rawFactors = Array.isArray(input.factors) ? input.factors.map(normalizeFactor) : [];
  const factors = rawFactors.map((factor) => {
    const sourceRefs = factor.productSpecificSource.evidenceRefs.filter((id) => knownEvidenceIds.has(id));
    return {
      ...factor,
      evidenceRefs: factor.evidenceRefs.filter((id) => knownEvidenceIds.has(id)),
      observedIngredientRefs: factor.observedIngredientRefs.filter((id) => observationIds.has(id)),
      productSpecificSource: sourceRefs.length
        ? { ...factor.productSpecificSource, evidenceRefs: sourceRefs }
        : { ...factor.productSpecificSource, state: "UNKNOWN", value: null, evidenceRefs: [] },
    };
  });
  const acceptedIds = acceptedEvidenceIds(evidence, entityType);
  const acceptedExpertIds = new Set(acceptedEvidence(evidence)
    .filter((item) => item.type === "EXPERT_REVIEWED" && acceptedIds.has(item.id))
    .map((item) => item.id).filter(Boolean));
  const factorIds = uniqueIds(factors);
  const legacyVerdict = String(legacy.verdict || "").toUpperCase();
  const requested = allowed(input.verdict || legacyVerdict, [...VERDICTS, "MUSHBOOH"], "UNKNOWN");
  let verdict = requested === "MUSHBOOH" ? "NEEDS_REVIEW" : requested;
  const unknowns = cleanList(input.unknowns);
  const unverified = cleanList(input.unverified);
  const match = deriveMatchState(input.identity?.matchState, evidence, entityType);
  if (match.contradictory) unverified.push("The asserted identity match state is not supported by the available evidence.");
  if (!value && legacyVerdict === "MUSHBOOH") unverified.push("A legacy needs-review claim requires current supporting evidence.");
  if (!supportsVerdict(verdict, entityType, evidence, factors, observedIngredients, match.state)) {
    unknowns.push("The available evidence does not support the requested determination.");
    verdict = "UNKNOWN";
  }
  if (entityType === "PRODUCT" && verdict === "NEEDS_REVIEW" && !hasMeaningfulUnresolvedIssue(factors, unknowns, unverified)) {
    unknowns.push("No supported unresolved issue explains the requested needs-review determination.");
    verdict = "UNKNOWN";
  }
  if (!value && (legacy.halal === true || legacy.certified === true || ["HALAL", "HARAM"].includes(legacyVerdict))) {
    unverified.push("A legacy halal-status claim exists without canonical evidence.");
  }
  const certification = certificationFromEvidence(evidence, entityType);
  return {
    version: 1, entityType, verdict, reason: clean(input.reason),
    explanation: normalizeExplanation(input.explanation, acceptedIds, factorIds),
    evidenceLevel: evidenceLevel(evidence, entityType), scope: normalizeScope(input.scope),
    identity: {
      barcode: clean(input.identity?.barcode || legacy.barcode),
      productName: clean(input.identity?.productName || legacy.name),
      brand: clean(input.identity?.brand || legacy.brand),
      region: clean(input.identity?.region), formulation: clean(input.identity?.formulation),
      matchState: match.state,
    },
    evidence, certification, factors, observedIngredients,
    verified: normalizeFactList(input.verified, acceptedIds),
    unverified: [...new Set(unverified)], unknowns: [...new Set(unknowns)],
    scholarlyConsiderations: normalizeScholarlyList(input.scholarlyConsiderations, acceptedExpertIds, factorIds, observationIds),
    nextActions: cleanList(input.nextActions), checkedAt: cleanDate(input.checkedAt),
  };
}

function normalizeProductTrust(product) {
  const raw = product && typeof product === "object" ? product : {};
  return normalizeTrust(raw.trust, { entityType: "PRODUCT", legacy: raw });
}
function normalizePlaceTrust(place) {
  const raw = place && typeof place === "object" ? place : {};
  return normalizeTrust(raw.trust, { entityType: "PLACE", legacy: raw });
}
function normalizeRecordSource(value) {
  const raw = value && typeof value === "object" ? value.kind : value;
  const token = String(raw || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  const kind = token === "openfoodfacts" || token === "open_food_facts"
    ? "OPEN_FOOD_FACTS"
    : allowed(raw, RECORD_SOURCE_KINDS, "UNKNOWN");
  return { kind, purpose: "PRODUCT_INFORMATION", halalEvidence: false };
}
function productEvidenceBasis(trust) {
  if (trust.certification) return "CERTIFIED";
  const accepted = acceptedEvidence(trust.evidence).filter((item) =>
    scopeSupportsEntity(item.scope, "PRODUCT") && hasTypeAppropriateProvenance(item)
  );
  if (accepted.some((item) => item.type === "MANUFACTURER_CONFIRMED")) return "MANUFACTURER_CONFIRMED";
  if (accepted.some((item) => item.type === "EXPERT_REVIEWED")) return "EXPERT_REVIEWED";
  if (accepted.some((item) => item.type === "INGREDIENT_ANALYSIS")) return "INGREDIENT_ANALYSIS";
  if (trust.evidence.some((item) => item.type === "COMMUNITY_REPORTED")) return "COMMUNITY_REPORTED";
  return "UNVERIFIED";
}
function buildProductResultContract(product, { recordSource = "UNKNOWN" } = {}) {
  const raw = product && typeof product === "object" ? product : {};
  const trust = normalizeProductTrust(raw);
  return {
    contractVersion: PRODUCT_RESULT_CONTRACT_VERSION,
    identity: {
      barcode: trust.identity.barcode, productName: trust.identity.productName, brand: trust.identity.brand,
      category: clean(raw.category), region: trust.identity.region, formulation: trust.identity.formulation,
      matchState: trust.identity.matchState, imageUrl: clean(raw.imageUrl || raw.image),
      ingredientsImageUrl: clean(raw.ingredientsImageUrl),
    },
    recordSource: normalizeRecordSource(recordSource),
    verdict: trust.verdict, evidenceBasis: productEvidenceBasis(trust), scope: trust.scope,
    explanation: trust.explanation, factors: trust.factors, observedIngredients: trust.observedIngredients,
    verifiedFacts: trust.verified, unverifiedClaims: trust.unverified, unknowns: trust.unknowns,
    certification: trust.certification, scholarlyContext: trust.scholarlyConsiderations,
    sources: trust.evidence, nextActions: trust.nextActions, checkedAt: trust.checkedAt,
  };
}
function buildProductLookupPayload(product, source) {
  const item = withProductTrust(product);
  return {
    ok: true,
    source,
    item,
    result: buildProductResultContract(item, { recordSource: source }),
  };
}
function createProductResultSnapshot(result, { scannedAt } = {}) {
  const timestamp = cleanTimestamp(scannedAt);
  if (!result || result.contractVersion !== PRODUCT_RESULT_CONTRACT_VERSION || !timestamp) return null;
  const barcode = clean(result.identity?.barcode);
  return {
    historyVersion: PRODUCT_HISTORY_CONTRACT_VERSION, kind: "PRODUCT_RESULT_SNAPSHOT",
    scannedAt: timestamp, barcode, isCurrent: false,
    currentLookup: barcode ? { barcode } : null,
    result: JSON.parse(JSON.stringify(result)),
  };
}
function normalizeProductHistoryEntry(entry) {
  const raw = entry && typeof entry === "object" ? entry : {};
  if (raw.historyVersion === PRODUCT_HISTORY_CONTRACT_VERSION && raw.kind === "PRODUCT_RESULT_SNAPSHOT") {
    return createProductResultSnapshot(raw.result, { scannedAt: raw.scannedAt });
  }
  const barcode = clean(raw.barcode || raw.code);
  return {
    historyVersion: 0, kind: "LEGACY_PRODUCT_SNAPSHOT",
    scannedAt: cleanTimestamp(raw.scannedAt || raw.savedAt || raw.createdAt),
    barcode, isCurrent: false, currentLookup: barcode ? { barcode } : null, result: null,
    legacyIdentity: { barcode, productName: clean(raw.name || raw.productName), brand: clean(raw.brand) },
    legacyVerdictAuthoritative: false,
  };
}
function withProductTrust(product) {
  const raw = product && typeof product === "object" ? product : {};
  return { ...raw, trust: normalizeProductTrust(raw) };
}
function withPlaceTrust(place) {
  const raw = place && typeof place === "object" ? place : {};
  return { ...raw, trust: normalizePlaceTrust(raw) };
}

module.exports = {
  PRODUCT_RESULT_CONTRACT_VERSION, PRODUCT_HISTORY_CONTRACT_VERSION,
  VERDICTS, EVIDENCE_TYPES, REVIEW_STATES, SCOPE_KINDS, SOURCE_STATES, FACTOR_ROLES, MATCH_STATES,
  normalizeEvidence, normalizeFactor, normalizeTrust, normalizeProductTrust, normalizePlaceTrust,
  normalizeRecordSource, buildProductResultContract, buildProductLookupPayload,
  createProductResultSnapshot, normalizeProductHistoryEntry,
  withProductTrust, withPlaceTrust,
};
