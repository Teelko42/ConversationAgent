/**
 * @aizen/web-client — Lane E. Headless renderer of the per-session stream
 * (transcript + concept cards + insights). Folds the BD-01 bus history into a
 * testable `RenderModel`; the conductor / E2E test render off it.
 */
export {
  renderStream,
  formatRender,
  type RenderModel,
  type TranscriptLine,
} from './render.js';
