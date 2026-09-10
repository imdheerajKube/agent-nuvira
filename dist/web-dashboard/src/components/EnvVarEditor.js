"use strict";
/**
 * Environment Variable Editor — Manages API keys for marketplace skills.
 *
 * This component allows users to:
 * - View all configured environment variables
 * - Add new environment variables
 * - Edit existing values
 * - Delete variables
 * - Test if variables are set correctly
 * - Import/export variable sets
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnvVarEditor = EnvVarEditor;
const react_1 = require("react");
// ─── Component ───────────────────────────────────────────────────────────
function EnvVarEditor({ envVars, onSave, onDelete, onTest, readOnly = false, }) {
    const [editingVar, setEditingVar] = (0, react_1.useState)(null);
    const [editValue, setEditValue] = (0, react_1.useState)('');
    const [showAdd, setShowAdd] = (0, react_1.useState)(false);
    const [newName, setNewName] = (0, react_1.useState)('');
    const [newValue, setNewValue] = (0, react_1.useState)('');
    const [testingVar, setTestingVar] = (0, react_1.useState)(null);
    const [testResults, setTestResults] = (0, react_1.useState)({});
    // Sort: required first, then by name
    const sortedVars = [...envVars].sort((a, b) => {
        if (a.requiredBy && !b.requiredBy)
            return -1;
        if (!a.requiredBy && b.requiredBy)
            return 1;
        return a.name.localeCompare(b.name);
    });
    const handleSave = (name) => {
        onSave(name, editValue);
        setEditingVar(null);
        setEditValue('');
    };
    const handleAdd = () => {
        if (newName && newValue) {
            onSave(newName, newValue);
            setNewName('');
            setNewValue('');
            setShowAdd(false);
        }
    };
    const handleTest = async (name) => {
        if (!onTest)
            return;
        setTestingVar(name);
        try {
            const result = await onTest(name);
            setTestResults((prev) => ({ ...prev, [name]: result }));
        }
        catch {
            setTestResults((prev) => ({ ...prev, [name]: false }));
        }
        finally {
            setTestingVar(null);
        }
    };
    return (<div className="env-var-editor">
      <div className="env-var-header">
        <h3 className="env-var-title">🔐 Environment Variables</h3>
        {!readOnly && (<button className="admin-mini-btn" type="button" onClick={() => setShowAdd(!showAdd)}>
            {showAdd ? '✕ Cancel' : '+ Add Variable'}
          </button>)}
      </div>

      {/* Add new variable form */}
      {showAdd && !readOnly && (<div className="env-var-add-form">
          <input className="env-var-input" type="text" placeholder="Variable name (e.g., MY_API_KEY)" value={newName} onChange={(e) => setNewName(e.target.value)}/>
          <input className="env-var-input" type="password" placeholder="Value" value={newValue} onChange={(e) => setNewValue(e.target.value)}/>
          <button className="admin-refresh-btn" type="button" disabled={!newName || !newValue} onClick={handleAdd}>
            💾 Save
          </button>
        </div>)}

      {/* Variable list */}
      <div className="env-var-list">
        {sortedVars.length === 0 ? (<div className="env-var-empty">
            No environment variables configured. Add one to get started.
          </div>) : (sortedVars.map((envVar) => (<div key={envVar.name} className={`env-var-row ${envVar.isSet ? 'env-var-set' : 'env-var-missing'} ${envVar.isProviderCredential ? 'env-var-blocked' : ''}`}>
              <div className="env-var-row-header">
                <span className="env-var-name">
                  {envVar.name}
                  {envVar.requiredBy && (<span className="env-var-required-badge">
                      required by {envVar.requiredBy}
                    </span>)}
                  {envVar.isProviderCredential && (<span className="env-var-blocked-badge">
                      🔒 provider credential (blocked)
                    </span>)}
                </span>
                <span className="env-var-status">
                  {envVar.isSet ? '✅ Set' : '❌ Not set'}
                </span>
              </div>

              {envVar.description && (<div className="env-var-description">{envVar.description}</div>)}

              {editingVar === envVar.name ? (<div className="env-var-edit">
                  <input className="env-var-input" type="password" value={editValue} onChange={(e) => setEditValue(e.target.value)} placeholder="Enter new value..."/>
                  <button className="admin-refresh-btn" type="button" onClick={() => handleSave(envVar.name)}>
                    💾 Save
                  </button>
                  <button className="admin-mini-btn" type="button" onClick={() => setEditingVar(null)}>
                    Cancel
                  </button>
                </div>) : (<div className="env-var-actions">
                  {!readOnly && !envVar.isProviderCredential && (<button className="admin-mini-btn" type="button" onClick={() => {
                        setEditingVar(envVar.name);
                        setEditValue('');
                    }}>
                      ✏️ Edit
                    </button>)}
                  {onTest && (<button className="admin-mini-btn" type="button" disabled={testingVar === envVar.name} onClick={() => handleTest(envVar.name)}>
                      {testingVar === envVar.name ? '⏳ Testing...' : '🧪 Test'}
                    </button>)}
                  {!readOnly && (<button className="admin-mini-btn admin-mini-btn-danger" type="button" onClick={() => onDelete(envVar.name)}>
                      🗑️ Delete
                    </button>)}
                  {testResults[envVar.name] !== undefined && (<span className={`env-var-test-result ${testResults[envVar.name] ? 'env-var-test-pass' : 'env-var-test-fail'}`}>
                      {testResults[envVar.name] ? '✅ Valid' : '❌ Invalid'}
                    </span>)}
                </div>)}
            </div>)))}
      </div>

      {/* Help text */}
      <div className="env-var-help">
        <p>
          <strong>Tip:</strong> Environment variables are stored in <code>~/.nuvira/.env</code> and
          injected into skill executions. Provider credentials (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
          are automatically blocked from skill execution for security.
        </p>
      </div>
    </div>);
}
exports.default = EnvVarEditor;
