// Number of quiz stages in the immersion. Shared by client and server: the
// count was previously hardcoded as `6` in the quiz page, the generation gate
// and the batch-process gate, so they could drift apart silently.
export const TOTAL_STAGES = 6;
