# Accurate Gap Analysis: Agent-Nuvira vs Hermes

**Date:** August 22, 2026
**Audit Type:** Line-by-line code comparison with tool registry verification

---

## Executive Summary

| Dimension | Hermes | Agent-Nuvira | Status |
|-----------|--------|--------------|--------|
| **Registered tools** | 109 | 56 | 51% coverage |
| **Bundled skills** | 71 | 153 | ✅ +115% ahead |
| **Tool categories** | 22 | 12 | 55% coverage |
| **Tool depth (avg lines)** | 1,200 | 450 | 38% depth |
| **Delegation system** | 6,322 lines | 925 lines | 15% depth |

**Overall:** Agent-Nuvira has MORE skills but FEWER tools and LESS depth than Hermes.

---

## Category 1: MATCHED (Tools We Have ✅)

### Core UX Tools
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| clarify_tool | ask_user | ✅ Matched |
| todo_tool | todo | ✅ Matched |
| suggest_followups | suggest_followups | ✅ Matched |
| verify_requirement | verify_requirement | ✅ Matched |
| skill_manager_tool | skill | ✅ Matched |

### Browser Automation
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| browser_tool | browser | ✅ Matched |
| browser_cdp_tool | browser (CDP) | ✅ Matched |
| browser_camofox | camofox | ✅ Matched |
| browser_supervisor | browser_supervisor | ✅ Matched |
| browser_dialog_tool | browser_dialog | ✅ Matched |

### MCP Integration
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| mcp_tool | mcp_oauth | ✅ Matched |
| mcp_oauth | mcp_oauth | ✅ Matched |
| mcp_schema_cache | mcp_schema_cache | ✅ Matched |
| mcp_stdio_watchdog | mcp_watchdog | ✅ Matched |

### Delegation
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| delegate_tool | delegate_system | ✅ Matched |
| delegation_live_log | delegate_system | ✅ Matched |
| async_delegation | delegate_system | ✅ Matched |
| managed_tool_gateway | managed_gateway | ✅ Matched |

### File Operations
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| file_operations | file_ops | ✅ Matched |
| file_state | file_ops | ✅ Matched |
| file_tools | file_ops | ✅ Matched |
| blueprints | blueprint | ✅ Matched |
| working_diff | working_diff | ✅ Matched |

### Security
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| schema_sanitizer | sanitize | ✅ Matched |
| binary_extensions | binary_extensions | ✅ Matched |
| credential_files | env_probe | ✅ Matched |
| env_probe | env_probe | ✅ Matched |

### Productivity
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| kanban_tools | kanban | ✅ Matched |
| cronjob_tools | cronjob | ✅ Matched |
| session_search_tool | session | ✅ Matched |
| thread_context | session | ✅ Matched |

### Debug
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| debug_helpers | debug | ✅ Matched |
| terminal_hints | debug | ✅ Matched |
| hook_output_spill | debug | ✅ Matched |

### Media
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| tts_tool | speak | ✅ Matched |
| transcription_tools | transcribe | ✅ Matched |
| vision_tools | vision | ✅ Matched |
| image_generation_tool | generate_image | ✅ Matched |

### Docker
| Hermes Tool | Nuvira Equivalent | Status |
|------------|-------------------|--------|
| docker (implied) | docker | ✅ Matched |

---

## Category 2: PARTIAL GAPS (We Have But Less Deep)

### Delegation Depth
| Feature | Hermes | Nuvira | Gap |
|---------|--------|--------|-----|
| Spawn depth limiting | ✅ MAX_DEPTH=1, configurable | ✅ maxSpawnDepth=1 | **MATCHED** |
| Concurrent children | ✅ Default 3, configurable | ✅ Default 3, configurable | **MATCHED** |
| Kill switch | ✅ Global kill switch | ✅ Global kill switch | **MATCHED** |
| Interrupt handling | ✅ request_hard_interrupt | ✅ interrupt() | **MATCHED** |
| Stall monitoring | ✅ Built-in | ✅ 30s interval | **MATCHED** |
| Real LLM calls in child | ✅ AIAgent instances | ⚠️ Fork + env vars | **PARTIAL** |
| Parent toolset inheritance | ✅ Full inheritance | ⚠️ Config-based | **PARTIAL** |
| Live log streaming | ✅ File-based + TUI | ✅ File-based | **MATCHED** |
| Spawn tree visualization | ✅ Full tree | ✅ getSpawnTree() | **MATCHED** |

### MCP Depth
| Feature | Hermes | Nuvira | Gap |
|---------|--------|--------|-----|
| MCP client | ✅ mcp_tool.py (full) | ✅ mcp-oauth.ts | **PARTIAL** |
| MCP OAuth | ✅ mcp_oauth.py | ✅ mcp-oauth.ts | **MATCHED** |
| MCP schema cache | ✅ mcp_schema_cache.py | ✅ mcp-schema-cache.ts | **MATCHED** |
| MCP watchdog | ✅ mcp_stdio_watchdog.py | ✅ mcp-watchdog.ts | **MATCHED** |
| MCP dashboard OAuth | ✅ mcp_dashboard_oauth.py | ❌ Missing | **GAP** |
| MCP OAuth manager | ✅ mcp_oauth_manager.py | ⚠️ In mcp-oauth.ts | **PARTIAL** |

### Security Depth
| Feature | Hermes | Nuvira | Gap |
|---------|--------|--------|-----|
| Schema sanitizer | ✅ Full | ✅ Full | **MATCHED** |
| AST audit | ✅ skills_ast_audit.py | ❌ Missing | **GAP** |
| Threat patterns | ✅ threat_patterns.py | ❌ Missing | **GAP** |
| URL safety | ✅ url_safety.py | ❌ Missing | **GAP** |
| Path security | ✅ path_security.py | ❌ Missing | **GAP** |
| Tirith security | ✅ tirith_security.py | ❌ Missing | **GAP** |
| Skills guard | ✅ skills_guard.py | ❌ Missing | **GAP** |

---

## Category 3: GAPS (Hermes Tools With No Nuvira Equivalent)

### Tier 1: High Impact (Core Agent Capabilities)
| Tool | Purpose | Impact | Effort |
|------|---------|--------|--------|
| **computer_use_tool** | Desktop automation (click, type, screenshot) | HIGH | 5 days |
| **desktop_ui** | Desktop UI control (window management) | HIGH | 3 days |
| **code_execution_tool** | Sandboxed code execution | HIGH | 3 days |
| **interrupt** | Global interrupt for all operations | HIGH | 1 day |
| **daemon_pool** | Background daemon process management | HIGH | 2 days |
| **process_registry** | Track all running processes | MEDIUM | 1 day |
| **checkpoint_manager** | Save/restore execution state | MEDIUM | 2 days |

### Tier 2: Medium Impact (Platform Integrations)
| Tool | Purpose | Impact | Effort |
|------|---------|--------|--------|
| **homeassistant_tool** | Home Assistant integration | MEDIUM | 2 days |
| **microsoft_graph_auth** | Microsoft 365 auth | MEDIUM | 2 days |
| **microsoft_graph_client** | Microsoft Graph API | MEDIUM | 2 days |
| **discord_tool** | Discord bot integration | MEDIUM | 1 day |
| **feishu_doc_tool** | Feishu document management | MEDIUM | 1 day |
| **feishu_drive_tool** | Feishu drive management | MEDIUM | 1 day |
| **react_to_message_tool** | React to messages | LOW | 0.5 days |
| **send_message_tool** | Send messages | LOW | 0.5 days |

### Tier 3: Medium Impact (AI/Media)
| Tool | Purpose | Impact | Effort |
|------|---------|--------|--------|
| **flux3_video_tool** | Video generation (FAL) | MEDIUM | 2 days |
| **xai_video_tools** | xAI video generation | MEDIUM | 1 day |
| **image_source** | Image source detection | LOW | 0.5 days |
| **voice_mode** | Voice interaction mode | MEDIUM | 3 days |
| **wake_word** | Wake word detection | LOW | 2 days |
| **neutts_synth** | NeuTTS synthesis | LOW | 1 day |

### Tier 4: Low Impact (Niche Integrations)
| Tool | Purpose | Impact | Effort |
|------|---------|--------|--------|
| **openrouter_client** | OpenRouter LLM client | LOW | 1 day |
| **x_search_tool** | X/Twitter search | LOW | 1 day |
| **xai_http** | xAI HTTP client | LOW | 0.5 days |
| **yuanbao_tools** | Yuanbao integration | LOW | 1 day |
| **fal_common** | FAL AI common utilities | LOW | 0.5 days |
| **osv_check** | OSV vulnerability check | LOW | 1 day |
| **homeassistant_tool** | Home Assistant | LOW | 2 days |

### Tier 5: Infrastructure (Internal)
| Tool | Purpose | Impact | Effort |
|------|---------|--------|--------|
| **lazy_deps** | Lazy dependency loading | LOW | 1 day |
| **tool_backend_helpers** | Backend helpers | LOW | 1 day |
| **tool_output_limits** | Output size limits | LOW | 0.5 days |
| **tool_result_storage** | Result storage | LOW | 0.5 days |
| **tool_search** | Tool search | LOW | 1 day |
| **budget_config** | Budget configuration | LOW | 0.5 days |
| **focus_pane_tool** | Focus pane | LOW | 0.5 days |
| **read_terminal_tool** | Terminal reading | LOW | 0.5 days |
| **open_preview_tool** | Preview opening | LOW | 0.5 days |
| **close_terminal_tool** | Terminal closing | LOW | 0.5 days |
| **ansi_strip** | ANSI escape stripping | LOW | 0.5 days |
| **fuzzy_match** | Fuzzy string matching | LOW | 0.5 days |
| **patch_parser** | Patch file parsing | LOW | 1 day |
| **website_policy** | Website policy enforcement | LOW | 0.5 days |

---

## Category 4: NUVIRA ADVANTAGES (We're Ahead)

| Feature | Hermes | Nuvira | Advantage |
|---------|--------|--------|-----------|
| **Bundled skills** | 71 | 153 | +115% |
| **Skill categories** | 22 | 24 | +9% |
| **Cloud sandboxes** | ❌ None | ✅ Modal + Daytona | Better |
| **Execution environments** | 0 | 6 | Better |
| **Skill provenance** | ❌ None | ✅ SHA-256 tracking | Better |
| **Execution audit** | ❌ None | ✅ Full audit logging | Better |
| **Dashboard UI** | ❌ None | ✅ React dashboard | Better |
| **Docker management** | ❌ Implied | ✅ Full tool + skills | Better |

---

## Recommended Priority

### Phase 1: Critical (1-2 weeks)
1. **computer_use_tool** — Desktop automation (biggest capability gap)
2. **desktop_ui** — Desktop UI control
3. **interrupt** — Global interrupt
4. **daemon_pool** — Background process management
5. **code_execution_tool** — Sandboxed code execution

### Phase 2: Important (2-4 weeks)
6. **Security tools** — AST audit, threat patterns, URL safety, path security
7. **Platform integrations** — Home Assistant, Microsoft Graph, Discord
8. **Media tools** — Video generation, voice mode
9. **MCP dashboard OAuth** — Dashboard integration

### Phase 3: Nice-to-Have (4-8 weeks)
10. **Niche integrations** — OpenRouter, X/Twitter, xAI
11. **Infrastructure** — Lazy deps, tool search, budget config
12. **Windows-specific** — Windows automation, PowerShell

---

## Estimated Effort

| Phase | Tools | Effort | Impact |
|-------|-------|--------|--------|
| Phase 1 | 5 tools | 2 weeks | HIGH — closes biggest gaps |
| Phase 2 | 12 tools | 4 weeks | MEDIUM — platform parity |
| Phase 3 | 20+ tools | 8 weeks | LOW — niche integrations |
| **Total** | **37+ tools** | **14 weeks** | **Full parity** |

---

## Conclusion

Agent-Nuvira is **ahead in skills** (153 vs 71) but **behind in tools** (56 vs 109) and **depth** (450 avg lines vs 1,200).

The most critical gaps are:
1. **Desktop automation** (computer_use, desktop_ui) — enables OS-level control
2. **Security depth** (6 missing tools) — enterprise security
3. **Platform integrations** (Home Assistant, Microsoft) — ecosystem reach
4. **Infrastructure** (daemon pool, process registry) — reliability

With Phase 1 complete, Agent-Nuvira would match Hermes in **core capabilities** while maintaining its **skill advantage**.
