import { SEED_REFERENCE_NOW } from "../src/db/seed.js";

export const DEFAULT_LIVE_MODEL = "claude-sonnet-5-5";
export const DEFAULT_EFFORT = "medium";
export const DEFAULT_MAX_TURNS = 12;
export const DEFAULT_MAX_TOKENS = 16_000;
/** Pinned store clock for every eval run. */
export const EVAL_CLOCK = SEED_REFERENCE_NOW;
