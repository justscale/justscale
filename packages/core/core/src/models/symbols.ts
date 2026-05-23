/**
 * Symbols for internal metadata on models.
 *
 * Most use plain Symbol() to avoid cross-version collisions - each
 * package version has its own symbols, so mismatched metadata shapes
 * never cause silent data corruption. Cross-module symbols that must
 * survive HMR use Symbol.for() instead.
 */

// ============================================
// Observable & Model symbols (from @justscale/observable)
// ============================================

/** Symbol to access model internals (schema, dirty tracking, etc.) */
export const MODEL_INTERNALS = Symbol('model_internals');

/** Symbol to access observable internals (dirty tracking, etc.) */
export const OBSERVABLE_META = Symbol('observable_meta');

// ============================================
// Reference symbols (for Promise-like refs)
// ============================================

/** Symbol to mark an object as a Reference */
export const REFERENCE = Symbol('models:reference');

/** Symbol to mark an object as a References collection */
export const REFERENCES = Symbol('models:references');

/** Symbol for internal reference ID storage */
export const REF_ID = Symbol('models:ref:id');

/** Symbol for internal reference IDs storage (plural) */
export const REF_IDS = Symbol('models:refs:ids');

/** Symbol for cached resolved value */
export const REF_VALUE = Symbol('models:ref:value');

/** Symbol for cached resolved values (plural) */
export const REF_VALUES = Symbol('models:refs:values');

/** Symbol for resolver function */
export const REF_RESOLVER = Symbol('models:ref:resolver');

/** Symbol-keyed method to attach resolver (internal use) */
export const SET_RESOLVER = Symbol('models:ref:setResolver');

/** Symbol-keyed method to hydrate a reference with a pre-loaded value (internal use) */
export const HYDRATE = Symbol('models:ref:hydrate');

// ============================================
// Transient Reference symbols (for unsaved entities)
// ============================================

/** Symbol to mark an object as a TransientRef */
export const TRANSIENT_REF = Symbol('models:transientRef');

/** Symbol for internal transient target storage */
export const TRANSIENT_TARGET = Symbol('models:transientRef:target');

// ============================================
// Instance State symbols (for runtime type safety)
// ============================================

/** Symbol to mark an instance as persisted (stored by an adapter) */
export const PERSISTENT = Symbol('models:persistent');

/** Symbol for adapter-stored key on a persistent entity (non-enumerable) */
export const ADAPTER_KEY = Symbol('models:adapterKey');

/** Symbol to mark an instance as transient (not yet saved) */
export const TRANSIENT = Symbol('models:transient');

/** Symbol to mark an instance as locked (for safe mutations) */
export const LOCK = Symbol('models:lock');

// ============================================
// Internal Storage symbols (for field values on instances)
// ============================================

/** Symbol for internal field storage on model instances */
export const FIELD_STORAGE = Symbol('models:fieldStorage');

/** Symbol for model context (registry, resolvers, etc.) */
export const MODEL_CONTEXT = Symbol('models:modelContext');

/** Symbol for model methods (type-level only, for extraction by Persistent/Transient) */
export const MODEL_METHODS = Symbol('models:modelMethods');

// ============================================
// ModelRepository Token symbols (for DI)
// ============================================

/** Symbol to store the base model on a repository token */
export const MODEL_REPO_MODEL = Symbol('models:modelRepoModel');

/** Symbol for custom repository that links to base ModelRepository token */
export const MODEL_REPO_BASE_TOKEN = Symbol('models:modelRepoBaseToken');

/** Symbol for storage model factory (creates repository from deps) */
export const CREATE_MODEL_REPO = Symbol('models:createModelRepo');

/** Symbol to store custom repository contract type on a model */
export const MODEL_REPO_CONTRACT = Symbol('models:modelRepoContract');

// ============================================
// Access Control symbols
// ============================================

/** Symbol to store field-level access rules on a model class */
export const ACCESS_RULES = Symbol('models:accessRules');

/** Symbol to store the raw permission defs record on a model class (for access rule evaluation) */
export const PERMISSION_DEFS = Symbol('models:permissionDefs');

// ============================================
// Model DI Injection symbols
// ============================================

/**
 * Symbol to store inject config on a model class.
 * Contains the raw { key: ServiceToken } map from defineModel({ inject }).
 * Symbol.for() for cross-module matching.
 */
export const MODEL_INJECT = Symbol.for('@justscale/core/models:modelInject');

/**
 * Symbol to store the resolved model service on a model class.
 * The model service is Object.create(ModelClass.prototype) with resolved inject deps.
 * Set during boot by Container.wireModelPrototypes().
 */
export const MODEL_SERVICE = Symbol.for('@justscale/core/models:modelService');
