/**
 * Domain reference-docs injection (v1.62.4).
 *
 * When a task mentions a known framework/domain, we inject CURATED reference
 * snippets into the writer's prompt so the model uses the real API instead of
 * hallucinating one. This is the fix for the live NVDA-addon failure where the
 * model invented `nvda.register_key_handler` / `from nvda import ui` instead of
 * the real `globalPluginHandler` / `scriptHandler` / `addonHandler` APIs.
 *
 * The snippets are small, hand-verified, and deliberately conservative: they
 * show the REAL public API surface + a minimal working example. Matching is
 * keyword-based against the task description (and optionally the goal); keep
 * the keywords specific enough to avoid false positives.
 */

export interface ReferenceDoc {
  /** Keywords that trigger this doc (lowercased, substring match). */
  keywords: string[];
  /** The curated snippet injected into the prompt. */
  snippet: string;
}

const NVDA_ADDON_SNIPPET = `## Reference: NVDA addon development (Python) — use THESE real APIs

An NVDA addon is a Python package with a manifest.ini at the addon root and one
or more globalPlugins modules. Do NOT invent APIs like nvda.register_key_handler
— the real, stable NVDA API is:

- manifest.ini (root of the addon):
  [addon]
  name = YourAddon
  summary = Short description
  description = Longer description
  author = You
  version = 1.0.0
  minNVDAVersion = 2021.1.0
  lastTestedNVDAVersion = 2026.1.0

- A module in globalPlugins/ (e.g. globalPlugins/your_addon.py):
  import addonHandler
  import globalPluginHandler
  import scriptHandler
  import ui

  addonHandler.initTranslation()

  class GlobalPlugin(globalPluginHandler.GlobalPlugin):
      def __init__(self, *args, **kwargs):
          super().__init__(*args, **kwargs)

      @scriptHandler.script(gesture="kb:NVDA+alt+1",
                            description="Speak a message",
                            category="YourAddon")
      def script_sayHello(self, gesture):
          ui.message("Hello Anuj Mote")

Key facts:
- Keyboard gestures use NVDA key names and the format "kb:..." (e.g. "kb:NVDA+alt+1",
  "kb:control+shift+h"). "NVDA" means the NVDA modifier key itself.
- Script methods are named script_<name> and decorated with @scriptHandler.script.
- Speak to the user with ui.message("...").
- GlobalPlugin subclasses MUST call super().__init__.
- The addon is packaged (buildVars.py + scons) only for distribution; the
  source tree needs manifest.ini + globalPlugins/ only.`;

const DOMAIN_DOCS: ReferenceDoc[] = [
  {
    // 'nvda' alone is too broad ("document NVDA behavior" would wrongly inject
    // the Python addon snippet) — require the addon signal.
    keywords: ['nvda addon', 'addon for nvda', 'nvda addon compatible'],
    snippet: NVDA_ADDON_SNIPPET,
  },
];

/**
 * Find reference docs matching the given text (task description + goal).
 * Returns a formatted prompt section, or '' when nothing matches.
 */
export function referenceDocsFor(text: string): string {
  const lower = text.toLowerCase();
  const matched: ReferenceDoc[] = [];
  for (const doc of DOMAIN_DOCS) {
    if (doc.keywords.some((k) => lower.includes(k))) {
      matched.push(doc);
    }
  }
  if (matched.length === 0) return '';
  return (
    '\n\n' +
    matched.map((d) => d.snippet).join('\n\n') +
    '\n'
  );
}
