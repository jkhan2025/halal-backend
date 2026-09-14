"use strict";

const mongoose = require("mongoose");

const REVIEW_STATES = ["ACCEPTED", "PENDING", "REJECTED", "UNREVIEWED"];
const CLAIM_TYPES = [
  "INDEPENDENT_CERTIFICATION",
  "BUSINESS_CONFIRMATION",
  "HALAL_MEAT_CLAIM",
  "MENU_COVERAGE_CLAIM",
  "COMMUNITY_REPORT",
  "EXPERT_REVIEWED_FINDING",
  "SUPPLIER_RELATIONSHIP",
  "SLAUGHTER_METHOD_INFORMATION",
];
const CLAIM_POSITIONS = ["AFFIRMS", "DISPUTES", "INFORMATIONAL"];
const COVERAGE_KINDS = [
  "ENTIRE_LOCATION",
  "MEAT_SERVED",
  "MENU_CATEGORY",
  "MENU_ITEM",
  "DEPARTMENT_OR_COUNTER",
  "NAMED_SUPPLIER",
  "CHAIN_LEVEL_ONLY",
];
const EVIDENCE_TYPES = [
  "CERTIFICATE",
  "BUSINESS_ATTESTATION",
  "COMMUNITY_REPORT",
  "EXPERT_REVIEW",
  "SUPPLIER_DOCUMENT",
  "SLAUGHTER_METHOD_DOCUMENT",
  "MENU_DOCUMENT",
  "OTHER_DOCUMENT",
];
const ISSUER_TYPES = [
  "CERTIFICATION_AUTHORITY",
  "BUSINESS",
  "OWNER",
  "COMMUNITY_MEMBER",
  "EXPERT",
  "SUPPLIER",
  "OTHER",
];
const CERTIFICATION_STATUSES = ["ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED", "UNKNOWN"];

const RestaurantSubjectSchema = new mongoose.Schema(
  {
    placeId: { type: String, trim: true },
    chainId: { type: String, trim: true },
  },
  { _id: false }
);

const RestaurantCoverageSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: COVERAGE_KINDS, required: true },
    placeId: { type: String, trim: true },
    chainId: { type: String, trim: true },
    menuCategoryId: { type: String, trim: true },
    menuItemId: { type: String, trim: true },
    departmentId: { type: String, trim: true },
    supplierId: { type: String, trim: true },
    label: { type: String, trim: true },
  },
  { _id: false }
);

const RestaurantPartySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ISSUER_TYPES },
    id: { type: String, trim: true },
    name: { type: String, trim: true },
  },
  { _id: false }
);

const RestaurantCertificationSchema = new mongoose.Schema(
  {
    authorityName: { type: String, trim: true },
    certificateId: { type: String, trim: true },
    status: { type: String, enum: CERTIFICATION_STATUSES },
    validFrom: Date,
    expiresAt: Date,
  },
  { _id: false }
);

const RestaurantClaimSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true, required: true },
    type: { type: String, enum: CLAIM_TYPES, required: true },
    position: { type: String, enum: CLAIM_POSITIONS },
    subject: { type: RestaurantSubjectSchema, default: undefined },
    coverage: { type: RestaurantCoverageSchema, default: undefined },
    claimant: { type: RestaurantPartySchema, default: undefined },
    reviewState: { type: String, enum: REVIEW_STATES },
    reviewedBy: { type: String, trim: true },
    evidenceRefs: { type: [{ type: String, trim: true }], default: undefined },
    effectiveFrom: Date,
    effectiveTo: Date,
    checkedAt: Date,
    limitations: { type: [{ type: String, trim: true }], default: undefined },
  },
  { _id: false }
);

const RestaurantEvidenceSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true, required: true },
    type: { type: String, enum: EVIDENCE_TYPES, required: true },
    subject: { type: RestaurantSubjectSchema, default: undefined },
    coverage: { type: RestaurantCoverageSchema, default: undefined },
    issuer: { type: RestaurantPartySchema, default: undefined },
    sourceRef: { type: String, trim: true },
    sourceUrl: { type: String, trim: true },
    reviewState: { type: String, enum: REVIEW_STATES },
    reviewedBy: { type: String, trim: true },
    sourceDate: Date,
    checkedAt: Date,
    effectiveFrom: Date,
    expiresAt: Date,
    relatedClaimRefs: { type: [{ type: String, trim: true }], default: undefined },
    limitations: { type: [{ type: String, trim: true }], default: undefined },
    certification: { type: RestaurantCertificationSchema, default: undefined },
  },
  { _id: false }
);

const RestaurantFactSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    text: { type: String, trim: true, required: true },
    claimRefs: { type: [{ type: String, trim: true }], default: undefined },
    evidenceRefs: { type: [{ type: String, trim: true }], default: undefined },
  },
  { _id: false }
);

const RestaurantTrustSchema = new mongoose.Schema(
  {
    version: { type: Number, enum: [1] },
    chain: {
      chainId: { type: String, trim: true },
      name: { type: String, trim: true },
    },
    claims: { type: [RestaurantClaimSchema], default: undefined },
    evidence: { type: [RestaurantEvidenceSchema], default: undefined },
    known: { type: [RestaurantFactSchema], default: undefined },
    unknowns: { type: [{ type: String, trim: true }], default: undefined },
    limitations: { type: [{ type: String, trim: true }], default: undefined },
    nextActions: { type: [{ type: String, trim: true }], default: undefined },
    checkedAt: Date,
    reviewedAt: Date,
    provenance: {
      recordSource: { type: String, trim: true },
      sourceRecordId: { type: String, trim: true },
      sourceUrl: { type: String, trim: true },
    },
  },
  { _id: false }
);

module.exports = {
  RestaurantTrustSchema,
  RestaurantClaimSchema,
  RestaurantEvidenceSchema,
  RestaurantCoverageSchema,
  RestaurantSubjectSchema,
  CLAIM_TYPES,
  CLAIM_POSITIONS,
  COVERAGE_KINDS,
  EVIDENCE_TYPES,
  REVIEW_STATES,
  ISSUER_TYPES,
  CERTIFICATION_STATUSES,
};
