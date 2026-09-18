export class UpdateError extends Error {}
export class IncompleteRelease extends UpdateError {}
export class SupplyChainError extends UpdateError {}
export class ManualReviewRequired extends SupplyChainError {}
