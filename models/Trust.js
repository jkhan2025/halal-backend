"use strict";

const mongoose = require("mongoose");

const ScopeSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["PRODUCT", "SKU", "FORMULATION", "BRAND", "BUSINESS", "DEPARTMENT", "PRODUCT_SELECTION", "INGREDIENT", "UNKNOWN"],
      default: "UNKNOWN",
    },
    target: { type: String, trim: true },
    region: { type: String, trim: true },
    formulation: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const EvidenceSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    type: {
      type: String,
      enum: ["CERTIFIED", "MANUFACTURER_CONFIRMED", "BUSINESS_CONFIRMED", "EXPERT_REVIEWED", "INGREDIENT_ANALYSIS", "COMMUNITY_REPORTED", "UNVERIFIED"],
      required: true,
    },
    reviewState: {
      type: String,
      enum: ["ACCEPTED", "PENDING", "REJECTED", "UNREVIEWED"],
      default: "UNREVIEWED",
    },
    title: { type: String, trim: true },
    authorityName: { type: String, trim: true },
    publisher: { type: String, trim: true },
    sourceUrl: { type: String, trim: true },
    sourceDate: Date,
    checkedAt: Date,
    scope: { type: ScopeSchema, default: undefined },
    notes: { type: String, trim: true },
    certificateId: { type: String, trim: true },
    validFrom: Date,
    expiresAt: Date,
    certificationStatus: {
      type: String,
      enum: ["ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED", "UNKNOWN"],
    },
  },
  { _id: false }
);

const ProductSourceSchema = new mongoose.Schema(
  {
    state: {
      type: String,
      enum: ["VERIFIED_PRODUCT_SPECIFIC", "MANUFACTURER_CONFIRMED", "CERTIFICATION_SUPPORTED", "OTHER_SUPPORTED", "UNKNOWN"],
      default: "UNKNOWN",
    },
    value: { type: String, trim: true },
    evidenceRefs: [{ type: String, trim: true }],
    notes: { type: String, trim: true },
  },
  { _id: false }
);

const FactorSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    role: {
      type: String,
      enum: ["DECISIVE", "SUPPORTING", "UNRESOLVED"],
      default: "SUPPORTING",
    },
    kind: { type: String, trim: true },
    label: { type: String, trim: true },
    finding: { type: String, trim: true },
    purpose: { type: String, trim: true },
    whyItMatters: { type: String, trim: true },
    status: { type: String, enum: ["CONFIRMED", "POSSIBLE", "UNKNOWN"], default: "UNKNOWN" },
    evidenceRefs: [{ type: String, trim: true }],
    observedIngredientRefs: [{ type: String, trim: true }],
    generalKnowledge: [{ type: String, trim: true }],
    possibleSources: [{ type: String, trim: true }],
    productSpecificSource: { type: ProductSourceSchema, default: undefined },
  },
  { _id: false }
);

const ObservedIngredientSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    rawText: { type: String, trim: true },
    normalizedName: { type: String, trim: true },
    additiveCode: { type: String, trim: true },
    position: { type: Number, min: 0 },
    sourceType: {
      type: String,
      enum: ["PACKAGE_LABEL", "INGREDIENT_IMAGE", "MANUFACTURER_DATA", "PROVIDER_IMPORT", "OTHER", "UNKNOWN"],
      default: "UNKNOWN",
    },
    ingredientsImageRef: { type: String, trim: true },
    extractionMethod: {
      type: String,
      enum: ["MANUAL", "OCR", "PROVIDER_IMPORT", "OTHER", "UNKNOWN"],
      default: "UNKNOWN",
    },
    reviewState: {
      type: String,
      enum: ["ACCEPTED", "PENDING", "REJECTED", "UNREVIEWED"],
      default: "UNREVIEWED",
    },
    evidenceRefs: [{ type: String, trim: true }],
  },
  { _id: false }
);

const ExplanationSchema = new mongoose.Schema(
  {
    summary: { type: String, trim: true },
    details: { type: String, trim: true },
    evidenceRefs: [{ type: String, trim: true }],
    factorRefs: [{ type: String, trim: true }],
    reviewState: {
      type: String,
      enum: ["ACCEPTED", "PENDING", "REJECTED", "UNREVIEWED"],
      default: "UNREVIEWED",
    },
    version: { type: Number, min: 1, default: 1 },
    reviewedAt: Date,
    reviewedBy: { type: String, trim: true },
  },
  { _id: false }
);

const FactSchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    text: { type: String, trim: true, required: true },
    evidenceRefs: [{ type: String, trim: true }],
  },
  { _id: false }
);

const ScholarlySchema = new mongoose.Schema(
  {
    id: { type: String, trim: true },
    school: { type: String, trim: true },
    text: { type: String, trim: true },
    position: { type: String, trim: true },
    authorityName: { type: String, trim: true },
    conditions: [{ type: String, trim: true }],
    exceptions: [{ type: String, trim: true }],
    applicability: { type: String, trim: true },
    factorRefs: [{ type: String, trim: true }],
    observedIngredientRefs: [{ type: String, trim: true }],
    evidenceRefs: [{ type: String, trim: true }],
    reviewState: {
      type: String,
      enum: ["ACCEPTED", "PENDING", "REJECTED", "UNREVIEWED"],
      default: "UNREVIEWED",
    },
    version: { type: Number, min: 1, default: 1 },
    publishedAt: Date,
    reviewedAt: Date,
  },
  { _id: false }
);

const TrustSchema = new mongoose.Schema(
  {
    version: { type: Number, default: 1 },
    verdict: { type: String, enum: ["HALAL", "HARAM", "NEEDS_REVIEW", "UNKNOWN"], default: "UNKNOWN" },
    reason: { type: String, trim: true },
    scope: { type: ScopeSchema, default: undefined },
    identity: {
      barcode: { type: String, trim: true },
      productName: { type: String, trim: true },
      brand: { type: String, trim: true },
      region: { type: String, trim: true },
      formulation: { type: String, trim: true },
      matchState: { type: String, enum: ["EXACT_PRODUCT", "INGREDIENT_ONLY", "UNVERIFIED"], default: "UNVERIFIED" },
    },
    evidence: [EvidenceSchema],
    factors: [FactorSchema],
    observedIngredients: [ObservedIngredientSchema],
    explanation: { type: ExplanationSchema, default: undefined },
    verified: [FactSchema],
    unverified: [{ type: String, trim: true }],
    unknowns: [{ type: String, trim: true }],
    scholarlyConsiderations: [ScholarlySchema],
    nextActions: [{ type: String, trim: true }],
    checkedAt: Date,
  },
  { _id: false }
);

module.exports = {
  TrustSchema,
  EvidenceSchema,
  FactorSchema,
  ScopeSchema,
  ObservedIngredientSchema,
  ExplanationSchema,
};
