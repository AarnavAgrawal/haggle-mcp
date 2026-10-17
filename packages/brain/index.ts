/**
 * @haggle/brain — what Haggle knows about businesses.
 *
 *   const brain = createBrain({ store: storeFromEnv(), seed: true });
 *   await brain.learnFromReply(businessId, parsedReply, replyMeta);  // engine, after every reply
 *   await brain.estimate(request);                                   // `ask`
 *
 * createStubBrain() returns fixed data with the same interface.
 */
export { createBrain, type BrainOptions } from "./src/brain.ts";
export { createStubBrain } from "./src/stub.ts";
export { applyReply } from "./src/learn.ts";
export { FileStore, MemoryStore, SupabaseStore, storeFromEnv, type ProfileStore } from "./src/store.ts";
export { loadDirectory, routeChannel, DirectoryEntry } from "./src/directory.ts";
export { toBusinessProfileView, toEstimatesView } from "./src/views.ts";
