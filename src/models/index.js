import mongoose from "mongoose";

const { Schema } = mongoose;

const planSchema = new Schema({
  name: { type: String, required: true, unique: true, index: true },
  code: { type: String, required: true, unique: true, index: true },

  // Applications are no longer selected from the Plan UI. DMS is the only
  // active company application; HR and Production remain dormant for future
  // re-enabling without deleting their source modules.
  apps: {
    dms: { type: Boolean, default: true },
    hr: { type: Boolean, default: false },
    production: { type: Boolean, default: false }
  },

  modules: { type: Map, of: Boolean, default: {} },
  roleTemplateCodes: { type: [String], default: [] },

  // Optional MASTER Group attached to the plan.
  groupCode: { type: String, default: "", uppercase: true, trim: true, index: true },

  // Commercial pricing.
  monthlyAmount: { type: Number, default: 0, min: 0 },
  yearlyAmount: { type: Number, default: 0, min: 0 },

  addons: {
    otp: Boolean,
    advancedGst: Boolean,
    aiTargets: Boolean,
    familyAccounts: Boolean,
    barcode: Boolean
  },

  // null = Unlimited. A number = hard plan limit.
  limits: {
    users: { type: Number, default: null },
    employees: { type: Number, default: null },
    companies: { type: Number, default: null },
    warehouses: { type: Number, default: null },
    machines: { type: Number, default: null },
    storageGb: { type: Number, default: null },
    aiMonthly: { type: Number, default: null }
  },

  status: { type: String, default: "ACTIVE", index: true }
}, { timestamps: true });

const userSchema = new Schema({
  tenantKey: { type: String, index: true, default: "demo" },
  tenantId: { type: String, index: true, default: "" },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, index: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: "SUPERADMIN", index: true },
  roleId: { type: Schema.Types.ObjectId, ref: "Role", index: true },
  departmentId: { type: Schema.Types.ObjectId, ref: "Department", index: true },
  apps: { type: [String], default: ["dms"] },
  permissions: { type: [String], default: ["*"] },
  planCode: { type: String, default: "COMPLETE", index: true },
  status: { type: String, default: "ACTIVE" },
  mobile: String,
  // Simple person/account master fields. The Role selected by the Superadmin
  // is the Account Type; Department/rank continue to come from that Role.
  // Legacy compatibility: accountType continues to mirror the selected Role name.
  accountType: String,
  // Accounting classification is separate from Role/hierarchy. It uses the MASTER
  // Tally-style AccountTemplate catalogue (Capital, Expense, Income, Assets, etc.).
  tallyAccountTypeCode: { type: String, uppercase: true, trim: true, index: true },
  tallyAccountTypeName: String,
  tallyAccountNature: String,
  dateOfBirth: Date,
  fatherName: String,
  fatherMobile: String,
  motherMobile: String,
  drivingLicenseNumber: { type: String, uppercase: true, trim: true },
  country: { type: String, default: "India" },
  appointmentDate: Date,
  pfPercentage: { type: Number, default: 0 },
  bankDetails: {
    ifsc: { type: String, uppercase: true, trim: true },
    bankName: String, branchName: String, branchArea: String, bankAddress: String,
    city: String, state: String, stdCode: String, phone: String, contactNo: String,
    accountNumber: String, accountName: String
  },
  lastWorkingDetails: {
    firmName: String, profileName: String, address: String, contactNumber: String
  },
  references: [{ name: String, relation: String, mobile: String }],
  assignedToUserId: { type: Schema.Types.ObjectId, ref: "User", index: true },
  // Sales hierarchy geography. Sales Heads keep their territory/coverage here;
  // Sales Person customer ownership continues to use PincodeAssignment.
  coveragePincodes: { type: [String], default: [] },
  branchId: { type: Schema.Types.ObjectId, ref: "BranchOffice", index: true },
  salary: { type: Number, default: 0 },
  openingBalance: { type: Number, default: 0 },
  openingBalanceType: { type: String, enum: ["DR", "CR"], default: "DR" },
  openingFinancialYear: String,
  address: String,
  pan: { type: String, uppercase: true, trim: true, index: true, sparse: true },
  aadhaarHash: { type: String, select: false, index: true, sparse: true },
  aadhaarMasked: String,
  pincode: { type: String, index: true },
  area: String,
  city: String,
  district: String,
  state: String,
  // Existing login users remain enabled. New person/account records can be
  // created without exposing email/password fields by setting this false.
  loginEnabled: { type: Boolean, default: true, index: true },
  lastLoginAt: Date,
  lastLoginIp: String,
  lastLoginUserAgent: String,
  loginCount: { type: Number, default: 0 },
  employeeId: { type: String, index: true, sparse: true },
  department: String, designation: String, designationCode: { type: String, uppercase: true, index: true }, team: String, branch: String, warehouseId: { type: String, index: true }, territoryId: String,
  reportsTo: { type: Schema.Types.ObjectId, ref: "User", index: true },
  dataScope: { type: String, enum: ["SELF","ASSIGNED","TEAM","TERRITORY","WAREHOUSE","BRANCH","DEPARTMENT","COMPANY","ALL"], default: "SELF" },
  approvalLimits: { discountPct: Number, creditAmount: Number, orderAmount: Number },
  userOverrides: { type: Map, of: Boolean, default: {} },
  fieldAccess: { type: Schema.Types.Mixed, default: {} },
  workflowTransitions: { type: Schema.Types.Mixed, default: {} },
  accountingRequired: { type: Boolean, default: false },
  accountingMappings: [{
    relationshipType: { type: String, required: true },
    systemAccountCode: { type: String, required: true, index: true },
    ledgerName: { type: String, required: true },
    openingBalance: { type: Number, default: 0 },
    openingBalanceType: { type: String, enum: ["DR","CR"], default: "DR" },
    financialYear: String,
    status: { type: String, default: "ACTIVE" }
  }]
}, { timestamps: true });

const roleSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  name: { type: String, required: true }, code: { type: String, required: true }, description: String,
  apps: { type: [String], default: [] }, permissions: { type: [String], default: [] },
  departmentId: { type: Schema.Types.ObjectId, ref: "Department", index: true },
  hierarchyOrder: { type: Number, default: 0, min: 0, index: true },
  dataScope: { type: String, default: "SELF" },
  approvalLimits: { discountPct: Number, creditAmount: Number, orderAmount: Number },
  sourceTemplateCode: { type: String, index: true, sparse: true },
  templateVersion: { type: Number, default: 2 },
  locked: { type: Boolean, default: false }, status: { type: String, default: "ACTIVE" }
}, { timestamps: true });
roleSchema.index({ tenantKey: 1, code: 1 }, { unique: true });
roleSchema.index({ tenantKey: 1, departmentId: 1, hierarchyOrder: 1 });



const groupSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  name: { type: String, required: true, index: true },
  code: { type: String, required: true, uppercase: true, index: true },
  description: String,
  permissions: { type: [String], default: [] },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true },
  createdBy: String,
  updatedBy: String
}, { timestamps: true });
groupSchema.index({ tenantKey: 1, code: 1 }, { unique: true });
groupSchema.index({ tenantKey: 1, name: 1 });


const designationTemplateSchema = new Schema({
  tenantKey: { type: String, required: true, index: true, default: "__MASTER_DESIGNATION_TEMPLATES__" },
  name: { type: String, required: true, index: true },
  code: { type: String, required: true, uppercase: true, index: true },
  department: { type: String, index: true },
  description: String,
  apps: { type: [String], default: [] },
  permissions: { type: [String], default: [] },
  dataScope: { type: String, default: "SELF" },
  allowedScopes: { type: [String], default: ["SELF"] },
  fieldAccess: { type: Schema.Types.Mixed, default: {} },
  workflowTransitions: { type: Schema.Types.Mixed, default: {} },
  approvalLimits: { discountPct: Number, creditAmount: Number, orderAmount: Number },
  templateVersion: { type: Number, default: 1 },
  status: { type: String, default: "ACTIVE", index: true }
}, { timestamps: true });
designationTemplateSchema.index({ tenantKey:1, code:1 }, { unique:true });

const branchOfficeSchema = new Schema({
  tenantKey: { type:String, required:true, index:true },
  branchCode: { type:String, required:true, uppercase:true, index:true },
  name: { type:String, required:true, index:true },
  address: String, pincode: String, district: String, state: String,
  status: { type:String, default:"ACTIVE", index:true },
  createdBy: String, updatedBy: String
}, {timestamps:true});
branchOfficeSchema.index({tenantKey:1,branchCode:1},{unique:true});

const employeeSchema = new Schema({
  tenantKey: { type: String, required: true, index: true }, employeeId: { type: String, required: true },
  name: { type: String, required: true, index: true }, mobile: String, email: String, dob: Date, joiningDate: Date,
  department: String, designation: String, designationCode: { type: String, uppercase: true, index: true }, team: String, branch: String, warehouseId: { type: String, index: true }, territoryId: String, reportsTo: String,
  employmentType: { type: String, default: "FULL_TIME" }, shift: String, salary: Number,
  bank: Schema.Types.Mixed, statutory: Schema.Types.Mixed, address: Schema.Types.Mixed, documentFileIds: [String],
  userId: String, status: { type: String, default: "ACTIVE" }
}, { timestamps: true });
employeeSchema.index({ tenantKey: 1, employeeId: 1 }, { unique: true });

const jobOpeningSchema = new Schema({
  tenantKey: { type: String, required: true, index: true }, jobId: { type: String, required: true }, title: { type: String, required: true },
  department: String, designation: String, location: String, vacancies: { type: Number, default: 1 }, employmentType: String,
  qualification: String, experience: String, salaryMin: Number, salaryMax: Number, skills: [String], reportingManagerId: String,
  requiredJoiningDate: Date, reason: String, status: { type: String, default: "DRAFT", index: true }, createdBy: String
}, { timestamps: true });
jobOpeningSchema.index({ tenantKey: 1, jobId: 1 }, { unique: true });

const candidateSchema = new Schema({
  tenantKey: { type: String, required: true, index: true }, candidateId: { type: String, required: true },
  name: { type: String, required: true, index: true }, mobile: { type: String, index: true }, email: { type: String, index: true },
  jobId: { type: String, index: true }, source: String, city: String, pincode: String, address: String, dob: Date,
  education: String, experience: String, currentCompany: String, currentSalary: Number, expectedSalary: Number, noticePeriod: String,
  preferredLocation: String, skills: [String], languages: [String], resumeFileId: String, photoFileId: String,
  stage: { type: String, default: "NEW", index: true }, fitScore: Number, interviewScore: Number,
  interviewRounds: [{ round: String, date: Date, interviewerId: String, score: Number, result: String, remarks: String }],
  offer: { salary: Number, joiningDate: Date, status: String, sentAt: Date, acceptedAt: Date },
  documents: [{ type: String, fileId: String, status: String, remarks: String }],
  employeeId: String, status: { type: String, default: "ACTIVE" }
}, { timestamps: true });
candidateSchema.index({ tenantKey: 1, candidateId: 1 }, { unique: true });

const genericRecordSchema = new Schema({
  tenantKey: { type: String, required: true, index: true }, app: { type: String, required: true, index: true }, resource: { type: String, required: true, index: true },
  reference: { type: String, index: true }, title: { type: String, required: true, index: true }, status: { type: String, default: "ACTIVE", index: true },
  date: Date, amount: Number, quantity: Number, assignedTo: String, notes: String, tags: [String], data: { type: Schema.Types.Mixed, default: {} },
  createdBy: String, updatedBy: String
}, { timestamps: true });
genericRecordSchema.index({ tenantKey: 1, app: 1, resource: 1, createdAt: -1 });

const globalCustomerSchema = new Schema({
  hiddenId: { type: String, required: true, unique: true, index: true },
  legalName: { type: String, required: true, index: true },
  customerType: { type: String, enum: ["BUSINESS", "INDIVIDUAL"], default: "BUSINESS" },
  gstins: [{ value: { type: String, uppercase: true }, state: String, status: String, verifiedAt: Date }],
  pan: { type: String, uppercase: true, index: true, sparse: true },
  aadhaarHash: { type: String, select: false, index: true, sparse: true },
  aadhaarMasked: String,
  mobiles: [{ value: String, verified: Boolean, primary: Boolean, active: { type: Boolean, default: true } }],
  emails: [{ value: String, verified: Boolean, primary: Boolean, active: { type: Boolean, default: true } }],
  tradeName: String,
  registeredAddress: String,
  gstProfile: { taxpayerType: String, constitution: String, registrationDate: Date, lastVerifiedAt: Date, filingStatus: String },
  globalHealth: { score: { type: Number, default: 0 }, grade: String, color: String, confidence: String, updatedAt: Date },
  linkedTenants: [{ tenantKey: String, linkedAt: Date }]
}, { timestamps: true });
globalCustomerSchema.index({ "gstins.value": 1 }, { unique: true, sparse: true });
globalCustomerSchema.index({ "mobiles.value": 1 });
globalCustomerSchema.index({ "emails.value": 1 });

const customerLinkSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  globalCustomerId: { type: String, required: true, index: true },
  displayIdentifier: { type: String, required: true, index: true },
  localName: String,
  customerType: { type: String, default: "BUSINESS" },
  paymentType: { type: String, enum: ["CASH", "CREDIT"], default: "CASH" },
  creditDays: { type: Number, default: 0 },
  creditLimit: { type: Number, default: 0 },
  graceDays: { type: Number, default: 0 },
  salespersonId: String,
  territoryId: String,
  sourceLeadId: { type: String, index: true },

  // Previous-DMS customer master fields retained in V2. They are tenant-local
  // commercial/profile data; global GST/PAN identity remains in GlobalCustomer.
  firstName: String,
  lastName: String,
  ownerName: String,
  ownerMobile: String,
  ownerPan: { type: String, uppercase: true, trim: true },
  ownerAadhaarHash: { type: String, select: false },
  ownerAadhaarMasked: String,
  passportNumber: String,
  ownerAddress: String,
  ownerPincode: String,
  ownerArea: String,
  ownerCity: String,
  ownerDistrict: String,
  ownerState: String,

  partyType: { type: String, default: "DEBITOR" },
  registrationType: { type: String, default: "UNKNOWN" },
  customerCode: String,
  dealsInProducts: String,
  annualTurnover: { type: Number, default: 0 },
  address2: String,
  companyContactNumber: String,
  shopSize: String,
  regionType: { type: String, default: "LOCAL" },
  category: String,
  dueDate: Date,
  assignedTransport: String,
  assignedTransportGlobalId: String,
  assignedTransportBookingStationId: String,
  assignedTransportDeliveryStationId: String,
  serviceArea: String,
  bankDetails: [{
    ifsc: { type: String, uppercase: true, trim: true },
    bankName: String, branchName: String, branchArea: String, bankAddress: String,
    city: String, state: String, stdCode: String, phone: String, contactNo: String,
    accountName: String, accountNumber: String
  }],
  portalLoginEnabled: { type: Boolean, default: false },
  portalPasswordHash: { type: String, select: false },

  priceList: String,
  gradeCode: { type: String, uppercase: true, index: true },
  gradeDiscountPct: { type: Number, default: 0 },
  status: { type: String, enum:["DRAFT","PENDING_VERIFICATION","PENDING_APPROVAL","ACTIVE","ON_HOLD","BLOCKED","REJECTED","DEACTIVATED","INACTIVE"], default: "PENDING_APPROVAL", index: true },
  contacts: [{
    name: String, designation: String, mobile: String, email: String,
    mobileVerified: { type:Boolean, default:false }, emailVerified: { type:Boolean, default:false },
    primary: { type:Boolean, default:false }, active: { type:Boolean, default:true }
  }],
  addresses: [{
    type: { type:String, default:"BILLING" }, address: String, pincode: String, area: String, city: String, district: String, state: String,
    latitude: Number, longitude: Number, accuracy: Number, capturedAt: Date, verified: { type:Boolean, default:false }
  }],
  documents: [{ type:String, fileId:String, status:{ type:String, default:"PENDING" }, remarks:String }],
  verification: {
    identity: Boolean, mobile: Boolean, email: Boolean, gps: Boolean, kyc: Boolean, appLinked: Boolean
  },
  location: { latitude: Number, longitude: Number, accuracy: Number, capturedAt: Date },
  requestedTerms: {
    paymentType: String, creditDays: Number, creditLimit: Number, graceDays: Number, priceList: String, requestedBy: String, requestedAt: Date
  },
  approvedTerms: {
    paymentType: String, creditDays: Number, creditLimit: Number, graceDays: Number, priceList: String, approvedBy: String, approvedAt: Date
  },
  approval: {
    status: { type:String, default:"PENDING" }, submittedBy:String, submittedAt:Date, reviewedBy:String, reviewedAt:Date, remarks:String, decision:String
  },
  approvalHistory: [{ action:String, by:String, at:Date, remarks:String, changes:Schema.Types.Mixed }],
  changeRequests: [{
    requestId:String, requestedBy:String, requestedAt:Date, changes:Schema.Types.Mixed,
    status:{ type:String, default:"PENDING" }, reviewedBy:String, reviewedAt:Date, remarks:String
  }],
  hold: { reason:String, by:String, at:Date },
  accountingProfile: {
    systemAccountCode: { type:String, default:"SYS_SUNDRY_DEBTORS" }, ledgerName:String,
    openingBalance:Number, openingBalanceType:{ type:String, enum:["DR","CR"], default:"DR" }, financialYear:String
  },
  companyHealth: { score: Number, grade: String, color: String, updatedAt: Date }
}, { timestamps: true });
customerLinkSchema.index({ tenantKey: 1, globalCustomerId: 1 }, { unique: true });
customerLinkSchema.index({ tenantKey:1, status:1, salespersonId:1, territoryId:1 });

const pincodeSchema = new Schema({
  pincode: { type: String, required: true, index: true },
  area: { type: String, required: true, index: true },
  city: { type: String, required: true, index: true },
  district: { type: String, required: true, index: true },
  state: { type: String, required: true, index: true },
  country: { type: String, default: "India" },
  latitude: Number, longitude: Number, status: { type: String, default: "ACTIVE", index: true }
}, { timestamps: true });
// A PIN code can legitimately serve multiple areas/post offices.  The old
// single-field unique PIN index prevented a full India geography import.
pincodeSchema.index({ pincode: 1, area: 1, city: 1, district: 1, state: 1 }, { unique: true });
pincodeSchema.index({ state: 1, district: 1, city: 1, area: 1, pincode: 1 });

const hsnSchema = new Schema({
  code: { type: String, required: true, unique: true, index: true },
  type: { type: String, default: "HSN" },
  description: { type: String, required: true, text: true },
  gstRate: Number, cgstRate: Number, sgstRate: Number, igstRate: Number, cessRate: Number,
  effectiveFrom: Date, effectiveTill: Date, status: { type: String, default: "ACTIVE" }
}, { timestamps: true });



const ifscMasterSchema = new Schema({
  ifsc: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
  bank: { type: String, required: true, trim: true, index: true },
  branch: { type: String, trim: true, index: true },
  address: { type: String, trim: true },
  city: { type: String, trim: true, index: true },
  state: { type: String, trim: true, index: true },
  stdCode: { type: String, trim: true },
  phone: { type: String, trim: true },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true }
}, { timestamps: true });
ifscMasterSchema.index({ bank: 1, state: 1, city: 1, branch: 1 });

const globalTransporterMasterSchema = new Schema({
  masterKey: { type: String, required: true, unique: true, index: true },
  globalTransporterId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, trim: true, index: true },
  address: { type: String, trim: true },
  pincode: { type: String, trim: true, index: true },
  contactPerson: { type: String, trim: true, index: true },
  mobile: { type: String, trim: true, index: true },
  landline: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true, index: true },
  directoryGroups: [{ type: String, trim: true, index: true }],
  categories: [{ type: String, trim: true, index: true }],
  listingOccurrences: { type: Number, default: 1 },
  sourceUrls: [{ type: String, trim: true }],
  sourceName: { type: String, default: "TransportNagar.in" },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true }
}, { timestamps: true });
globalTransporterMasterSchema.index({ name: 1, mobile: 1 });
globalTransporterMasterSchema.index({ directoryGroups: 1 });
globalTransporterMasterSchema.index({ categories: 1 });


const globalTransporterStationSchema = new Schema({
  stationId: { type: String, required: true, unique: true, index: true },
  globalTransporterId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, index: true },
  stationType: { type: String, enum: ["BOOKING","DELIVERY","BOTH"], default: "BOTH", index: true },
  address: { type: String, trim: true },
  pincode: { type: String, trim: true, index: true },
  area: { type: String, trim: true, index: true },
  city: { type: String, trim: true, index: true },
  district: { type: String, trim: true, index: true },
  state: { type: String, trim: true, index: true },
  contacts: [{ name: String, designation: String, phone: String, email: String, active: { type: Boolean, default: true } }],
  servicePincodes: [{ type: String, trim: true, index: true }],
  serviceCities: [{ type: String, trim: true, index: true }],
  serviceStates: [{ type: String, trim: true, index: true }],
  sourceCategory: String,
  sourceDirectoryGroup: String,
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true }
}, { timestamps: true });
globalTransporterStationSchema.index({ globalTransporterId: 1, status: 1, stationType: 1 });
globalTransporterStationSchema.index({ pincode: 1, city: 1, state: 1, status: 1 });

const globalTransporterLaneSchema = new Schema({
  laneId: { type: String, required: true, unique: true, index: true },
  globalTransporterId: { type: String, required: true, index: true },
  originStationId: { type: String, required: true, index: true },
  destinationStationId: { type: String, required: true, index: true },
  transitDays: Number, minimumFreight: Number, freightNotes: String,
  doorDelivery: { type: Boolean, default: true }, codAvailable: { type: Boolean, default: false },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true }
}, { timestamps: true });
globalTransporterLaneSchema.index({ globalTransporterId: 1, originStationId: 1, destinationStationId: 1 }, { unique: true });

const unitSchema = new Schema({
  code: { type: String, required: true, unique: true, uppercase: true, index: true },
  name: { type: String, required: true, index: true },
  uqc: { type: String, uppercase: true },
  decimals: { type: Number, default: 0, min: 0, max: 6 },
  status: { type: String, default: "ACTIVE", index: true }
}, { timestamps: true });


const companyUnitSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  code: { type: String, required: true, uppercase: true, index: true },
  name: { type: String, required: true, index: true },
  uqc: { type: String, uppercase: true },
  decimals: { type: Number, default: 0, min: 0, max: 6 },
  status: { type: String, default: "ACTIVE", index: true }
}, { timestamps: true });
companyUnitSchema.index({ tenantKey: 1, code: 1 }, { unique: true });

const productCategorySchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  code: { type: String, required: true, uppercase: true, index: true },
  name: { type: String, required: true, index: true },
  subcategories: [{ code: String, name: String, status: { type: String, default: "ACTIVE" } }],
  status: { type: String, default: "ACTIVE", index: true }
}, { timestamps: true });
productCategorySchema.index({ tenantKey: 1, code: 1 }, { unique: true });

const customerGradeSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  code: { type: String, required: true, uppercase: true, index: true },
  name: { type: String, required: true, index: true },
  discountPct: { type: Number, default: 0, min: 0 },
  description: String,
  status: { type: String, default: "ACTIVE", index: true }
}, { timestamps: true });
customerGradeSchema.index({ tenantKey: 1, code: 1 }, { unique: true });

const priceListSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  code: { type: String, required: true, uppercase: true, index: true },
  name: { type: String, required: true, index: true },
  gradeCode: { type: String, uppercase: true, index: true },
  defaultDiscountPct: { type: Number, default: 0 },
  status: { type: String, default: "ACTIVE", index: true }
}, { timestamps: true });
priceListSchema.index({ tenantKey: 1, code: 1 }, { unique: true });

const priceListItemSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  priceListCode: { type: String, required: true, uppercase: true, index: true },
  productId: { type: String, required: true, index: true },
  overridePrice: Number,
  overrideDiscountPct: Number
}, { timestamps: true });
priceListItemSchema.index({ tenantKey: 1, priceListCode: 1, productId: 1 }, { unique: true });

const accountTemplateSchema = new Schema({
  systemCode: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  parentCode: String,
  nature: { type: String, enum: ["ASSET", "LIABILITY", "INCOME", "EXPENSE", "EQUITY"] },
  reportMap: { trading: Boolean, pnl: Boolean, balanceSheet: Boolean, cma: Boolean, cashFlow: String },
  locked: { type: Boolean, default: true },
  allowCompanyLedger: { type: Boolean, default: false }
}, { timestamps: true });


const companyLedgerSchema = new Schema({
  tenantKey: { type:String, required:true, index:true },
  ledgerId: { type:String, required:true, unique:true, index:true },
  ownerType: { type:String, enum:["COMPANY","STAKEHOLDER","USER","CUSTOMER","EMPLOYEE","BANK_ACCOUNT","OTHER"], required:true, index:true },
  ownerId: { type:String, required:true, index:true },
  relationshipType: { type:String, required:true, index:true },
  systemAccountCode: { type:String, required:true, index:true },
  name: { type:String, required:true, index:true },
  openingBalances: [{ financialYear:String, amount:{type:Number,default:0}, type:{type:String,enum:["DR","CR"],default:"DR"} }],
  status: { type:String, default:"ACTIVE", index:true },
  createdFrom: String
}, {timestamps:true});
companyLedgerSchema.index({tenantKey:1,ownerType:1,ownerId:1,relationshipType:1,systemAccountCode:1},{unique:true});


const bankAccountSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  bankAccountId: { type: String, required: true, unique: true, index: true },
  bankName: { type: String, required: true, index: true },
  branchName: String,
  branchAddress: String,
  city: String, state: String, stdCode: String, phone: String, contactNo: String,
  accountHolderName: { type: String, required: true },
  accountNumber: { type: String, required: true },
  accountNumberNormalized: { type: String, required: true, index: true },
  ifsc: { type: String, uppercase: true, trim: true, index: true },
  micr: String,
  swiftCode: { type: String, uppercase: true, trim: true },
  upiId: String,
  accountType: {
    type: String,
    enum: ["CURRENT", "SAVINGS", "OD", "CC", "OTHER"],
    default: "CURRENT",
    index: true
  },
  // Legacy single-FY fields are retained for backward compatibility.
  openingBalance: { type: Number, default: 0 },
  openingBalanceType: { type: String, enum: ["DR", "CR"], default: "DR" },
  financialYear: String,
  // Every financial year keeps its own opening balance. Bank statement imports
  // can infer this from the first running-balance row, while users may edit it.
  openingBalances: [{
    financialYear: { type:String, required:true },
    amount: { type:Number, default:0 },
    type: { type:String, enum:["DR","CR"], default:"DR" },
    source: { type:String, default:"MANUAL" },
    updatedAt: Date, updatedBy: String
  }],
  isPrimary: { type: Boolean, default: false, index: true },
  status: { type: String, enum: ["ACTIVE", "INACTIVE", "DELETED"], default: "ACTIVE", index: true },
  remarks: String,
  ledgerId: String,
  createdBy: String,
  updatedBy: String,
  deletedAt: Date,
  deletedBy: String
}, { timestamps: true });
bankAccountSchema.index({ tenantKey: 1, accountNumberNormalized: 1 }, { unique: true });

const stakeholderSchema = new Schema({
  stakeholderId: { type:String, required:true },
  name: { type:String, required:true },
  roleType: { type:String, required:true },
  pan:String,
  aadhaarHash:{type:String,select:false},
  aadhaarMasked:String,
  dinDpin:String,
  mobile:String,
  email:String,
  designation:String,
  ownershipPct:Number,
  profitSharePct:Number,
  contribution:Number,
  openingCapital:Number,
  joiningDate:Date,
  active:{type:Boolean,default:true},
  shareholder:{type:Boolean,default:false},
  systemLoginRequired:{type:Boolean,default:false},
  accountingRelationships:[{
    relationshipType:String,
    systemAccountCode:String,
    ledgerName:String,
    openingBalance:{type:Number,default:0},
    openingBalanceType:{type:String,enum:["DR","CR"],default:"CR"},
    financialYear:String,
    status:{type:String,default:"ACTIVE"}
  }]
},{_id:false});

const companyProfileSchema = new Schema({
  tenantKey: { type:String, required:true, unique:true, index:true },
  companyName: { type:String, required:true, index:true },
  tradeName:String,
  companyType: { type:String, enum:["PROPRIETORSHIP","PARTNERSHIP","LLP","PRIVATE_LIMITED","PUBLIC_LIMITED","OPC","TRUST","SOCIETY","OTHER"], required:true, index:true },
  gstin:{type:String,uppercase:true,index:true},
  pan:{type:String,uppercase:true,index:true},
  aadhaarHash:{type:String,select:false},
  aadhaarMasked:String,
  mobile:String,
  email:String,
  registeredAddress:String,
  pincode:String,
  city:String,
  state:String,
  // Multiple financial years may be enabled for the same company.
  // financialYear is retained as the default/current FY for legacy transaction flows.
  financialYear:String,
  financialYears:{type:[String],default:[]},
  // Sales invoice number series configured by the company Superadmin.
  // Final format: PREFIX-NUMBER-SUFFIX. nextNumber is consumed atomically.
  salesInvoicePrefix:{type:String,default:""},
  salesInvoiceSuffix:{type:String,default:""},
  salesInvoiceStartingNumber:{type:Number,default:1,min:1},
  salesInvoiceNextNumber:{type:Number,default:1,min:1},
  // Central invoice print assets/settings used by the Master Invoice Template.
  logoFileId:{type:String,default:""},
  signatureFileId:{type:String,default:""},
  invoiceTerms:{type:String,default:"GOODS ONCE SOLD CANNOT BE TAKEN BACK, TRANSPORTATION RISK AT BUYER SIDE"},
  gpayNumber:{type:String,default:""},
  hasMultipleBranches:{type:Boolean,default:false},
  branchCount:{type:Number,default:1,min:1},
  planCode:{type:String,index:true},
  planGroupCode:{type:String,index:true},
  billingCycle:{type:String,enum:["MONTHLY","YEARLY"],default:"YEARLY"},
  paymentStatus:{type:String,default:"PENDING",index:true},
  paymentRef:{type:String,index:true},
  subscriptionStartAt:Date,
  subscriptionEndAt:Date,
  renewalDate:Date,
  lastRenewedAt:Date,
  autoRenew:{type:Boolean,default:false},
  graceDays:{type:Number,default:0,min:0,max:365},
  subscriptionStatus:{type:String,default:"ACTIVE",index:true},
  planHistory:[{
    planCode:String,
    billingCycle:String,
    startAt:Date,
    endAt:Date,
    paymentRef:String,
    amountRupees:Number,
    action:String,
    changedBy:String,
    at:{type:Date,default:Date.now}
  }],
  gstVerification:{
    verified:{type:Boolean,default:false},
    source:String,
    status:String,
    taxpayerType:String,
    constitution:String,
    verifiedAt:Date
  },
  stakeholders:[stakeholderSchema],
  constitutionHistory:[{from:String,to:String,effectiveDate:Date,reason:String,approvedBy:String,at:Date}],
  status:{type:String,default:"ACTIVE",index:true},
  deletedAt:Date,
  deletedBy:String,
  deleteReason:String,
  createdBy:String
},{timestamps:true});

const platformPaymentSchema = new Schema({
  paymentRef:{type:String,required:true,unique:true,index:true},
  tenantKey:{type:String,index:true},
  companyName:String,
  gstin:{type:String,uppercase:true,index:true},
  planCode:{type:String,required:true,index:true},
  billingCycle:{type:String,enum:["MONTHLY","YEARLY"],required:true,index:true},
  amountRupees:{type:Number,required:true,min:0},
  amountPaise:{type:Number,required:true,min:0},
  currency:{type:String,default:"INR"},
  provider:{type:String,default:"RAZORPAY"},
  razorpayOrderId:{type:String,index:true},
  razorpayPaymentId:{type:String,index:true},
  status:{type:String,enum:["ORDER_CREATED","PAID","MANUAL_PAID","FREE","FAILED"],default:"ORDER_CREATED",index:true},
  manualNote:String,
  createdBy:String,
  verifiedAt:Date,
  linkedUserId:String,
  linkedCompanyProfileId:String,
  subscriptionStartAt:Date,
  subscriptionEndAt:Date
},{timestamps:true});

const productSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  sku: { type: String, required: true, index: true },
  name: { type: String, required: true, index: true },
  category: { type: String, index: true },
  subCategory: { type: String, index: true },
  productSection: String,
  warehouseId: String,
  hsnCode: String,
  hsnDescription: { type: String, default: "" },
  gstRate: { type: Number, default: 0 },
  basicUnit: { type: String, default: "PCS" },
  packingUnit: String,
  qtyInBag: { type: Number, default: 1, min: 0 },
  unit: { type: String, default: "PCS" },
  openingStock: { type: Number, default: 0 },
  openingRate: { type: Number, default: 0 },
  currentStock: { type: Number, default: 0 },
  lastPurchasePrice: { type: Number, default: 0 },
  averagePurchasePrice: { type: Number, default: 0 },
  purchaseQtyAccumulated: { type: Number, default: 0 },
  purchaseValueAccumulated: { type: Number, default: 0 },
  landedCost: { type: Number, default: 0 },
  mrp: { type: Number, default: 0 },
  salePrice: { type: Number, default: 0 },
  minStockAlert: { type: Number, default: 0 },
  minimumProfitPct: { type: Number, default: 3 },
  // Old-DMS price-list fields: actual pricing margin, highest grade baseline and colour band.
  profitPercentage: { type: Number, default: 3 },
  maxGradeDiscountPct: { type: Number, default: 0 },
  profitColorCode: { type: String, default: "RED" },
  pricingScheme: { type: String, default: "STANDARD" },
  barcode: String,
  barcodeSource: { type: String, default: "" },
  imageFileIds: [String],
  status: { type: String, default: "ACTIVE" }
}, { timestamps: true });
productSchema.index({ tenantKey: 1, sku: 1 }, { unique: true });

const transporterSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  globalTransporterId: { type: String, index: true },
  name: { type: String, required: true, index: true },
  gstin: String, pan: String,
  stations: [{
    name: String, type: { type: String, default: "BOTH" }, address: String, pincode: String,
    latitude: Number, longitude: Number,
    contacts: [{ name: String, designation: String, phone: String, email: String, active: { type: Boolean, default: true } }]
  }],
  paymentTerms: String, freightNotes: String, status: { type: String, default: "ACTIVE" }
}, { timestamps: true });
transporterSchema.index({ tenantKey: 1, globalTransporterId: 1 }, { unique: true, partialFilterExpression: { globalTransporterId: { $type: "string" } } });

const departmentSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  reference: { type: String, uppercase: true, trim: true, index: true, sparse: true },
  name: { type: String, required: true, trim: true, index: true },
  code: { type: String, required: true, uppercase: true, trim: true, index: true },
  description: { type: String, default: "" },

  // MASTER-controlled permission ceiling for this Department. A tenant Role
  // assigned to the Department can never exceed this list. When
  // permissionConfigured=false (legacy/new Department before its first
  // permission upload), the Department does not clamp permissions yet.
  permissions: { type: [String], default: [] },
  permissionConfigured: { type: Boolean, default: false, index: true },
  permissionUpdatedAt: Date,
  permissionUpdatedBy: String,

  customerAssignmentEnabled: { type: Boolean, default: false, index: true },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true },
  createdBy: String,
  updatedBy: String
}, { timestamps: true });
departmentSchema.index({ tenantKey: 1, code: 1 }, { unique: true });
departmentSchema.index({ tenantKey: 1, reference: 1 }, { unique: true, sparse: true });
departmentSchema.index({ tenantKey: 1, name: 1 });

const pincodeAssignmentSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  departmentId: { type: Schema.Types.ObjectId, ref: "Department", required: true, index: true },
  pincode: { type: String, required: true, trim: true, index: true },
  userIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE", index: true },
  createdBy: String,
  updatedBy: String
}, { timestamps: true });
pincodeAssignmentSchema.index({ tenantKey: 1, departmentId: 1, pincode: 1 }, { unique: true });
pincodeAssignmentSchema.index({ tenantKey: 1, pincode: 1, status: 1 });
pincodeAssignmentSchema.index({ tenantKey: 1, userIds: 1, status: 1 });

const territorySchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  name: { type: String, required: true },
  pincodes: [String],
  userId: String, managerId: String, status: { type: String, default: "ACTIVE" }
}, { timestamps: true });

const leadSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  leadId: { type: String, required: true, unique: true, index: true },
  companyName: { type: String, required: true, index: true },
  contactPerson: String,
  mobile: String,
  whatsapp: String,
  email: String,
  address: String,
  pincode: { type: String, index: true },
  city: String,
  state: String,
  source: String,
  sourceReference: String,
  productInterest: [String],
  bulkData: Schema.Types.Mixed,

  // Lead ownership is determined from the Sales Person pincode allotment.
  // If more than one Sales Person owns the same pincode, imports are balanced
  // to the person with the lowest number of open leads in that pincode.
  assignedUserId: { type: String, index: true },
  assignedAt: Date,
  assignmentMode: { type: String, default: "UNASSIGNED", index: true },
  territoryId: String,
  assignmentHistory: [{ fromUserId: String, toUserId: String, at: Date, by: String, reason: String }],

  stage: { type: String, default: "NEW", index: true },
  priority: { type: String, default: "NORMAL", index: true },
  nextFollowUpAt: { type: Date, index: true },
  lastActivityAt: Date,
  lastVisitAt: Date,
  visitCount: { type: Number, default: 0 },
  cancellation: { reason: String, note: String, cancelledAt: Date, cancelledBy: String },
  conversion: {
    status: { type: String, default: "NOT_STARTED" },
    startedAt: Date,
    startedBy: String,
    submittedAt: Date,
    customerGlobalId: String,
    customerStatus: String,
    verifiedAt: Date,
    verifiedBy: String,
    rejectedAt: Date,
    rejectedBy: String,
    remarks: String
  },
  // Backward-compatible activity storage. Older lead data may contain plain
  // strings, while the current lead workflow stores structured activity objects.
  // Mixed[] safely supports both formats without requiring a data migration.
  activities: { type: [Schema.Types.Mixed], default: [] }
}, { timestamps: true });
leadSchema.index({ tenantKey: 1, assignedUserId: 1, stage: 1, nextFollowUpAt: 1 });
leadSchema.index({ tenantKey: 1, pincode: 1, stage: 1 });
leadSchema.index({ tenantKey: 1, mobile: 1 }, { sparse: true });
leadSchema.index({ tenantKey: 1, email: 1 }, { sparse: true });

const leadCreationRequestSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  requestId: { type: String, required: true, unique: true, index: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
  requestedByName: String,
  pincode: { type: String, required: true, index: true },
  companyName: { type: String, required: true },
  mobile: String,
  address: String,
  city: String,
  state: String,
  contactPerson: String,
  whatsapp: String,
  email: String,
  source: String,
  sourceReference: String,
  productInterest: [String],
  priority: { type: String, default: "NORMAL" },
  note: String,
  status: { type: String, enum: ["PENDING", "APPROVED", "REJECTED", "CANCELLED"], default: "PENDING", index: true },
  reviewedBy: String,
  reviewedAt: Date,
  reviewRemark: String,
  approvedLeadId: String,
  approvedLeadObjectId: { type: Schema.Types.ObjectId, ref: "Lead" },
  assignedPincodeAt: Date,
}, { timestamps: true });
leadCreationRequestSchema.index({ tenantKey: 1, requestedBy: 1, status: 1, createdAt: -1 });
leadCreationRequestSchema.index({ tenantKey: 1, pincode: 1, status: 1 });

const leadVisitSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  leadObjectId: { type: Schema.Types.ObjectId, ref: "Lead", required: true, index: true },
  leadId: { type: String, required: true, index: true },
  salespersonId: { type: String, required: true, index: true },
  type: { type: String, enum: ["PHYSICAL_VISIT","CALL","WHATSAPP","FOLLOW_UP","OTHER"], default: "PHYSICAL_VISIT", index: true },
  visitAt: { type: Date, default: Date.now, index: true },
  outcome: String,
  note: String,
  nextFollowUpAt: Date,
  location: { latitude: Number, longitude: Number, accuracy: Number },
  customerLocation: { latitude: Number, longitude: Number },
  distanceMeters: Number,
  gpsVerified: { type: Boolean, default: false },
  otpVerified: { type: Boolean, default: false },
  photoFileIds: [String],
  createdBy: String
}, { timestamps: true });
leadVisitSchema.index({ tenantKey: 1, leadObjectId: 1, visitAt: -1 });
leadVisitSchema.index({ tenantKey: 1, salespersonId: 1, visitAt: -1 });


// V2 Sales Person field visit. Separate from LeadVisit because an approved
// customer visit belongs to the customer relationship, not the lead lifecycle.
const customerVisitSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  visitId: { type: String, required: true, unique: true, index: true },
  financialYear: { type: String, index: true },
  customerGlobalId: { type: String, required: true, index: true },
  customerNameSnapshot: String,
  salespersonId: { type: String, required: true, index: true },
  clientMutationId: { type: String, index: true, sparse: true },
  salespersonNameSnapshot: String,
  tripId: { type: String, index: true },
  visitType: { type: String, enum: ["MANUAL", "AUTO_DETECTED", "VOICE_CRM"], default: "MANUAL", index: true },
  status: { type: String, enum: ["IN_PROGRESS", "COMPLETED", "CANCELLED"], default: "COMPLETED", index: true },
  startedAt: { type: Date, default: Date.now, index: true },
  endedAt: Date,
  durationSeconds: { type: Number, default: 0 },
  outcome: String,
  note: String,
  nextFollowUpAt: Date,
  startLocation: { latitude: Number, longitude: Number, accuracy: Number },
  endLocation: { latitude: Number, longitude: Number, accuracy: Number },
  customerLocation: { latitude: Number, longitude: Number },
  minDistanceMeters: Number,
  gpsVerified: { type: Boolean, default: false },
  autoDetected: { type: Boolean, default: false, index: true },
  voiceTranscript: String,
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });
customerVisitSchema.index({ tenantKey: 1, salespersonId: 1, startedAt: -1 });
customerVisitSchema.index({ tenantKey: 1, customerGlobalId: 1, startedAt: -1 });
customerVisitSchema.index({ tenantKey: 1, customerGlobalId: 1, autoDetected: 1, startedAt: -1 });
customerVisitSchema.index({ tenantKey: 1, clientMutationId: 1 }, { unique: true, sparse: true });

// One route/trip document per field-sales journey. Points stay outside customer
// masters and accounting so route recording cannot bloat those documents.
const salespersonTripSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  tripId: { type: String, required: true, unique: true, index: true },
  salespersonId: { type: String, required: true, index: true },
  salespersonNameSnapshot: String,
  dateKey: { type: String, required: true, index: true },
  status: { type: String, enum: ["active", "completed", "cancelled"], default: "active", index: true },
  startedAt: { type: Date, default: Date.now, index: true },
  endedAt: Date,
  startLocation: { lat: Number, lng: Number, accuracy: Number, speed: Number, heading: Number, ts: String },
  endLocation: { lat: Number, lng: Number, accuracy: Number, speed: Number, heading: Number, ts: String },
  routePoints: [{ _id: false, lat: Number, lng: Number, accuracy: Number, speed: Number, heading: Number, ts: String }],
  pauseEvents: [{ _id: false, type: String, at: String, lat: Number, lng: Number }],
  pointCount: { type: Number, default: 0 },
  distanceMeters: { type: Number, default: 0 },
  durationSeconds: { type: Number, default: 0 },
  stoppedReason: String,
  routePlanId: { type: String, index: true },
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });
salespersonTripSchema.index({ tenantKey: 1, salespersonId: 1, dateKey: -1, startedAt: -1 });
salespersonTripSchema.index({ tenantKey: 1, salespersonId: 1, status: 1 });

// A daily field-sales route plan sits above the raw GPS trip. It turns ranked
// sales/collection opportunities into an accountable sequence of customer stops.
const salesRoutePlanSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  planNo: { type: String, required: true, unique: true, index: true },
  financialYear: { type: String, required: true, index: true },
  dateKey: { type: String, required: true, index: true },
  salespersonId: { type: String, required: true, index: true },
  salespersonNameSnapshot: String,
  status: { type: String, enum: ["DRAFT", "READY", "IN_PROGRESS", "COMPLETED", "CANCELLED"], default: "READY", index: true },
  generatedBy: { type: String, enum: ["AUTO", "REPLAN", "MANUAL"], default: "AUTO" },
  routeVersion: { type: Number, default: 1 },
  startLocation: { lat: Number, lng: Number, accuracy: Number, ts: String },
  currentLocation: { lat: Number, lng: Number, accuracy: Number, ts: String },
  startedAt: Date,
  completedAt: Date,
  tripId: String,
  maxStops: { type: Number, default: 12 },
  radiusMeters: { type: Number, default: 40000 },
  estimatedDistanceMeters: { type: Number, default: 0 },
  estimatedTravelMinutes: { type: Number, default: 0 },
  estimatedWorkMinutes: { type: Number, default: 0 },
  actualDistanceMeters: { type: Number, default: 0 },
  actualDurationSeconds: { type: Number, default: 0 },
  lastGpsAt: Date,
  totalOpportunityAmount: { type: Number, default: 0 },
  totalCollectionAmount: { type: Number, default: 0 },
  completedStops: { type: Number, default: 0 },
  skippedStops: { type: Number, default: 0 },
  notes: String,
  stops: [{
    _id: false,
    stopId: { type: String, required: true },
    sequence: { type: Number, required: true },
    customerGlobalId: { type: String, required: true, index: true },
    customerNameSnapshot: String,
    mobileSnapshot: String,
    addressSnapshot: String,
    citySnapshot: String,
    pincodeSnapshot: String,
    location: { lat: Number, lng: Number },
    priority: String,
    score: Number,
    opportunityType: String,
    recommendedAction: String,
    reason: String,
    opportunityAmount: { type: Number, default: 0 },
    collectionAmount: { type: Number, default: 0 },
    status: { type: String, enum: ["PENDING", "STARTED", "ARRIVED", "COMPLETED", "SKIPPED"], default: "PENDING", index: true },
    estimatedDistanceFromPreviousMeters: { type: Number, default: 0 },
    estimatedTravelMinutes: { type: Number, default: 0 },
    estimatedArrivalAt: Date,
    startedAt: Date,
    arrivedAt: Date,
    completedAt: Date,
    skippedAt: Date,
    skipReason: String,
    outcome: String,
    visitId: String,
    actualDistanceOnArrivalMeters: Number,
  }],
  createdBy: String,
  updatedBy: String,
}, { timestamps: true });
salesRoutePlanSchema.index({ tenantKey: 1, salespersonId: 1, dateKey: -1 }, { unique: true });
salesRoutePlanSchema.index({ tenantKey: 1, status: 1, dateKey: -1 });

// Voice-to-CRM stores the original transcript and the salesperson-approved
// structured interpretation. It never creates financial transactions itself.
const salesCrmActivitySchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  activityId: { type: String, required: true, unique: true, index: true },
  salespersonId: { type: String, required: true, index: true },
  clientMutationId: { type: String, index: true, sparse: true },
  salespersonNameSnapshot: String,
  customerGlobalId: { type: String, index: true },
  customerNameSnapshot: String,
  leadObjectId: { type: Schema.Types.ObjectId, ref: "Lead", index: true },
  leadNameSnapshot: String,
  channel: { type: String, enum: ["VOICE", "TEXT"], default: "VOICE" },
  transcript: { type: String, required: true },
  structured: { type: Schema.Types.Mixed, default: {} },
  outcome: String,
  nextFollowUpAt: Date,
  status: { type: String, enum: ["SAVED", "CANCELLED"], default: "SAVED", index: true },
  createdBy: String,
}, { timestamps: true });
salesCrmActivitySchema.index({ tenantKey: 1, customerGlobalId: 1, createdAt: -1 });
salesCrmActivitySchema.index({ tenantKey: 1, salespersonId: 1, createdAt: -1 });
salesCrmActivitySchema.index({ tenantKey: 1, clientMutationId: 1 }, { unique: true, sparse: true });

// Competitor intelligence captured by field sales. The source can be a
// manual visit note, OCR scan or Voice-to-CRM extraction.
const salesCompetitorIntelSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  competitorId: { type: String, required: true, unique: true, index: true },
  clientMutationId: { type: String, index: true, sparse: true },
  salespersonId: { type: String, required: true, index: true },
  salespersonNameSnapshot: String,
  customerGlobalId: { type: String, index: true },
  customerNameSnapshot: String,
  leadObjectId: { type: Schema.Types.ObjectId, ref: "Lead", index: true },
  competitorName: { type: String, required: true, index: true },
  productId: String,
  productName: String,
  quotedRate: { type: Number, default: 0 },
  scheme: String,
  creditDays: { type: Number, default: 0 },
  reasonCustomerPrefers: String,
  strengths: String,
  weaknesses: String,
  notes: String,
  source: { type: String, enum: ["MANUAL", "VOICE", "OCR"], default: "MANUAL", index: true },
  capturedAt: { type: Date, default: Date.now, index: true },
  location: { latitude: Number, longitude: Number, accuracy: Number },
  createdBy: String,
}, { timestamps: true });
salesCompetitorIntelSchema.index({ tenantKey: 1, clientMutationId: 1 }, { unique: true, sparse: true });
salesCompetitorIntelSchema.index({ tenantKey: 1, customerGlobalId: 1, capturedAt: -1 });
salesCompetitorIntelSchema.index({ tenantKey: 1, competitorName: 1, capturedAt: -1 });

const targetSchema = new Schema({
  tenantKey: { type: String, required: true, index: true },
  financialYear: { type: String, required: true, index: true },
  level: { type: String, enum: ["COMPANY", "REGION", "TERRITORY", "MANAGER", "USER", "CUSTOMER", "PRODUCT", "CATEGORY"] },
  entityId: { type: String, index: true },
  annual: { sales: Number, grossProfit: Number, collection: Number, visits: Number, newCustomers: Number },
  monthly: [{ month: String, sales: Number, grossProfit: Number, collection: Number, visits: Number, newCustomers: Number, status: String }],
  weights: { sales: Number, grossProfit: Number, collection: Number, productMix: Number, marginQuality: Number, newCustomers: Number, leadsVisits: Number },
  achievement: { sales: Number, grossProfit: Number, collection: Number, visits: Number, newCustomers: Number, overallScore: Number },
  status: { type: String, default: "DRAFT" },
  version: { type: Number, default: 1 }
}, { timestamps: true });

const barcodeSchema = new Schema({
  barcodeId: { type: String, required: true, unique: true, index: true },
  gtin: { type: String, unique: true, sparse: true, index: true },
  type: { type: String, default: "EAN13" }, owner: String, brand: String, sku: String, productName: String,
  status: { type: String, default: "AVAILABLE", index: true }, allocationHistory: [{ action: String, at: Date, by: String, note: String }]
}, { timestamps: true });

const brandingSchema = new Schema({
  key: { type: String, default: "GLOBAL", unique: true },
  slogan: { type: String, default: "This page is generated by the Rupioo Global System." },
  masterLogoFileId: String,
  website: String
}, { timestamps: true });

const fileMetaSchema = new Schema({
  fileId: { type: String, required: true, unique: true, index: true }, tenantKey: { type: String, index: true },
  module: String, entityType: String, entityId: String, originalName: String, mimeType: String, size: Number,
  storageKey: String, access: { type: String, default: "PRIVATE" }, checksum: String, uploadedBy: String
}, { timestamps: true });

const otpSchema = new Schema({
  otpId: { type: String, required: true, unique: true, index: true }, tenantKey: String, transactionId: String, actionType: String,
  recipientId: String, codeHash: { type: String, select: false }, expiresAt: Date, usedAt: Date, status: { type: String, default: "PENDING" },
  context: Schema.Types.Mixed
}, { timestamps: true });


const legacyMigrationMapSchema = new Schema({
  tenantKey: { type:String, required:true, index:true },
  entity: { type:String, required:true, index:true },
  legacyId: { type:String, required:true, index:true },
  newId: { type:String, default:"", index:true },
  runId: { type:String, index:true },
  status: { type:String, default:"IMPORTED", index:true },
  lastImportedAt: Date
},{timestamps:true});
legacyMigrationMapSchema.index({tenantKey:1,entity:1,legacyId:1},{unique:true});

const legacyMigrationRunSchema = new Schema({
  tenantKey: { type:String, required:true, index:true },
  tenantId: String, fileName: String, status: {type:String,default:"RUNNING",index:true},
  startedBy: String, startedAt: Date, completedAt: Date, summary: Schema.Types.Mixed, error: String
},{timestamps:true});

const legacyMigrationItemSchema = new Schema({
  tenantKey: { type:String, required:true, index:true }, runId: {type:String,required:true,index:true},
  entity: {type:String,required:true,index:true}, legacyId: {type:String,required:true,index:true},
  raw: Schema.Types.Mixed, status: {type:String,default:"NEEDS_COMPLETION",index:true},
  missingFields: [String], message: String, resolvedAt: Date, resolvedBy: String
},{timestamps:true});
legacyMigrationItemSchema.index({tenantKey:1,runId:1,entity:1,legacyId:1},{unique:true});

const addMigrationFields = (schema) => {
  schema.add({migration:{
    legacyId:{type:String,index:true}, runId:{type:String,index:true}, status:{type:String,index:true},
    profileComplete:{type:Boolean,default:true}, verified:{type:Boolean,default:true}, importedAt:Date,
    // Raw Previous-DMS row is retained so no source field is lost. Mapped V2
    // fields are usable immediately; unmapped/pending fields can be completed later.
    sourceData:{type:Schema.Types.Mixed,default:{}}
  }});
};
[
  userSchema, globalCustomerSchema, customerLinkSchema, companyUnitSchema, productCategorySchema,
  customerGradeSchema, bankAccountSchema, productSchema, transporterSchema, branchOfficeSchema, departmentSchema
].forEach(addMigrationFields);

export const Plan = mongoose.model("Plan", planSchema);
export const User = mongoose.model("User", userSchema);
export const Role = mongoose.model("Role", roleSchema);
export const Group = mongoose.model("Group", groupSchema);
export const DesignationTemplate = mongoose.model("DesignationTemplate", designationTemplateSchema);
export const BranchOffice = mongoose.model("BranchOffice", branchOfficeSchema);
export const Employee = mongoose.model("Employee", employeeSchema);
export const JobOpening = mongoose.model("JobOpening", jobOpeningSchema);
export const Candidate = mongoose.model("Candidate", candidateSchema);
export const GenericRecord = mongoose.model("GenericRecord", genericRecordSchema);
export const GlobalCustomer = mongoose.model("GlobalCustomer", globalCustomerSchema);
export const CustomerLink = mongoose.model("CustomerLink", customerLinkSchema);
export const Pincode = mongoose.model("Pincode", pincodeSchema);
export const Hsn = mongoose.model("Hsn", hsnSchema);
export const IfscMaster = mongoose.model("IfscMaster", ifscMasterSchema);
export const GlobalTransporterMaster = mongoose.model("GlobalTransporterMaster", globalTransporterMasterSchema);
export const GlobalTransporterStation = mongoose.model("GlobalTransporterStation", globalTransporterStationSchema);
export const GlobalTransporterLane = mongoose.model("GlobalTransporterLane", globalTransporterLaneSchema);
export const Unit = mongoose.model("Unit", unitSchema);
export const CompanyUnit = mongoose.model("CompanyUnit", companyUnitSchema);
export const ProductCategory = mongoose.model("ProductCategory", productCategorySchema);
export const CustomerGrade = mongoose.model("CustomerGrade", customerGradeSchema);
export const PriceList = mongoose.model("PriceList", priceListSchema);
export const PriceListItem = mongoose.model("PriceListItem", priceListItemSchema);
export const AccountTemplate = mongoose.model("AccountTemplate", accountTemplateSchema);
export const CompanyProfile = mongoose.model("CompanyProfile", companyProfileSchema);
export const PlatformPayment = mongoose.model("PlatformPayment", platformPaymentSchema);
export const CompanyLedger = mongoose.model("CompanyLedger", companyLedgerSchema);
export const BankAccount = mongoose.model("BankAccount", bankAccountSchema);
export const Product = mongoose.model("Product", productSchema);
export const Transporter = mongoose.model("Transporter", transporterSchema);
export const Department = mongoose.model("Department", departmentSchema);
export const PincodeAssignment = mongoose.model("PincodeAssignment", pincodeAssignmentSchema);
export const Territory = mongoose.model("Territory", territorySchema);
export const Lead = mongoose.model("Lead", leadSchema);
export const LeadCreationRequest = mongoose.model("LeadCreationRequest", leadCreationRequestSchema);
export const LeadVisit = mongoose.model("LeadVisit", leadVisitSchema);
export const CustomerVisit = mongoose.model("CustomerVisit", customerVisitSchema);
export const SalespersonTrip = mongoose.model("SalespersonTrip", salespersonTripSchema);
export const SalesRoutePlan = mongoose.model("SalesRoutePlan", salesRoutePlanSchema);
export const SalesCrmActivity = mongoose.model("SalesCrmActivity", salesCrmActivitySchema);
export const SalesCompetitorIntel = mongoose.model("SalesCompetitorIntel", salesCompetitorIntelSchema);
export const Target = mongoose.model("Target", targetSchema);
export const Barcode = mongoose.model("Barcode", barcodeSchema);
export const Branding = mongoose.model("Branding", brandingSchema);
export const FileMeta = mongoose.model("FileMeta", fileMetaSchema);
export const OtpChallenge = mongoose.model("OtpChallenge", otpSchema);
export const LegacyMigrationMap = mongoose.model("LegacyMigrationMap", legacyMigrationMapSchema);
export const LegacyMigrationRun = mongoose.model("LegacyMigrationRun", legacyMigrationRunSchema);
export const LegacyMigrationItem = mongoose.model("LegacyMigrationItem", legacyMigrationItemSchema);
