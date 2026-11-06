#!/usr/bin/env python3
"""
Validate OpenAPI specification.
Checks for required fields, valid schema, and best practices.
"""

import json
import sys
from pathlib import Path

# PyYAML is used when present. It is NOT a requirement any more: an obligation
# that can only be satisfied by installing a dependency is a broken obligation,
# and this script may be run by an agent on a machine with no site-packages.
try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover - depends on the environment
    yaml = None


class YamlSubsetError(ValueError):
    """The document uses YAML this reader cannot handle safely."""


def _strip_comment(line):
    out, quote = [], None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in '"\'':
            quote = ch
        elif ch == '#' and (i == 0 or line[i - 1] in ' \t'):
            break
        out.append(ch)
    return ''.join(out).rstrip()


def _scalar(text):
    t = text.strip()
    if t in ('', '~', 'null'):
        return None
    if t in ('true', 'True'):
        return True
    if t in ('false', 'False'):
        return False
    if len(t) >= 2 and t[0] == t[-1] and t[0] in '"\'':
        return t[1:-1]
    try:
        return int(t)
    except ValueError:
        pass
    try:
        return float(t)
    except ValueError:
        pass
    if t.startswith(('[', '{')):
        return _flow(t)
    return t


def _split_flow(text):
    """Split a flow collection on top-level commas (nesting and quotes aware)."""
    parts, depth, quote, cur = [], 0, None, []
    for ch in text:
        if quote:
            cur.append(ch)
            if ch == quote:
                quote = None
            continue
        if ch in '"\'':
            quote = ch
            cur.append(ch)
        elif ch in '[{':
            depth += 1
            cur.append(ch)
        elif ch in ']}':
            depth -= 1
            cur.append(ch)
        elif ch == ',' and depth == 0:
            parts.append(''.join(cur))
            cur = []
        else:
            cur.append(ch)
    if ''.join(cur).strip():
        parts.append(''.join(cur))
    return parts


def _flow(text):
    """Parse `[a, b]` / `{k: v}` — one level or nested, with plain scalars."""
    inner = text[1:-1].strip()
    if not inner:
        return [] if text[0] == '[' else {}
    parts = _split_flow(inner)
    if text[0] == '[':
        return [_scalar(p) for p in parts]
    out = {}
    for part in parts:
        k, sep, v = part.partition(':')
        if not sep:
            raise YamlSubsetError(f'flow mapping entry without a value: {part.strip()}')
        key = _scalar(k)
        if not isinstance(key, (str, int, float, bool)) or key is None:
            raise YamlSubsetError(f'unsupported flow mapping key: {k.strip()}')
        out[key] = _scalar(v)
    return out


def parse_yaml_subset(text):
    """Read the block-mapping/sequence subset an OpenAPI document uses.

    Deliberately strict: anchors, aliases, multi-document streams and any
    construct it does not model raise YamlSubsetError instead of being guessed
    at, so a bad parse can never masquerade as a passing validation.
    """
    items = []
    for raw in text.split('\n'):
        if not raw.strip() or raw.strip().startswith('#'):
            continue
        body = _strip_comment(raw)
        if not body.strip() or body.strip() in ('---', '...'):
            continue
        indent = len(body) - len(body.lstrip(' '))
        if '\t' in body[:indent]:
            raise YamlSubsetError('tab indentation')
        item = body.strip()
        if item.startswith(('&', '*')) or item == '<<':
            raise YamlSubsetError(f'anchors/aliases are not supported: {item}')
        items.append((indent, item))

    if not items:
        return {}

    def parse_map(i, indent):
        out = {}
        while i < len(items):
            ind, s = items[i]
            if ind < indent or (ind == indent and s.startswith('- ')):
                break
            if ind > indent:
                raise YamlSubsetError(f'unexpected indent: {s}')
            key, sep, rest = s.partition(':')
            if not sep:
                raise YamlSubsetError(f'expected "key: value": {s}')
            key = _scalar(key)
            rest = rest.strip()
            i += 1
            if rest in ('|', '>', '|-', '>-', '|+', '>+'):
                block = []
                while i < len(items) and items[i][0] > indent:
                    block.append(items[i][1])
                    i += 1
                out[key] = '\n'.join(block)
            elif rest == '':
                if i < len(items) and items[i][0] > indent:
                    out[key], i = parse_node(i, items[i][0])
                elif i < len(items) and items[i][0] == indent and items[i][1].startswith('- '):
                    out[key], i = parse_seq(i, indent)
                else:
                    out[key] = None
            else:
                out[key] = _scalar(rest)
        return out, i

    def parse_seq(i, indent):
        out = []
        while i < len(items):
            ind, s = items[i]
            if ind != indent or not s.startswith('- '):
                break
            rest = s[2:].strip()
            i += 1
            if rest == '':
                if i < len(items) and items[i][0] > indent:
                    val, i = parse_node(i, items[i][0])
                    out.append(val)
                else:
                    out.append(None)
            elif ':' in rest and rest[0] not in '"\'':
                key, _, val = rest.partition(':')
                entry = {_scalar(key): _scalar(val)}
                if i < len(items) and items[i][0] > indent:
                    more, i = parse_map(i, items[i][0])
                    if isinstance(more, dict):
                        entry.update(more)
                out.append(entry)
            else:
                out.append(_scalar(rest))
        return out, i

    def parse_node(i, indent):
        if items[i][1].startswith('- '):
            return parse_seq(i, indent)
        return parse_map(i, indent)

    value, pos = parse_node(0, items[0][0])
    if pos != len(items):
        raise YamlSubsetError(f'unparsed content: {items[pos][1]}')
    return value


def load_spec(file_path):
    """Load OpenAPI spec from a .yaml/.yml/.json file."""
    path = Path(file_path)
    if not path.exists():
        print(f"❌ File not found: {file_path}")
        return None

    text = path.read_text(encoding='utf-8')

    # The shipped `configs/openapi-template.yaml` is a MUSTACHE template, not a
    # document. Validating it used to die on `{{api_title}}` with a traceback
    # (with PyYAML as well), which reads as "the validator is broken".
    if '{{' in text:
        print("❌ This file still contains {{placeholders}} — it is a template, not a spec.")
        print("   Fill in the placeholders (or render the template), then validate the result.")
        return None

    if path.suffix not in ['.yaml', '.yml']:
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            print(f"❌ Not valid JSON: {exc}")
            return None

    if yaml is not None:
        return yaml.safe_load(text)
    try:
        return parse_yaml_subset(text)
    except YamlSubsetError as exc:
        print(f"❌ Cannot read this YAML without PyYAML ({exc}).")
        print("   Fix: pip install pyyaml, or convert the spec to JSON (python -m json.tool).")
        return None
    except Exception as exc:  # a reader bug must never look like a broken spec
        print(f"❌ Could not read the YAML ({type(exc).__name__}: {exc}).")
        print("   Fix: pip install pyyaml, or convert the spec to JSON (python -m json.tool).")
        return None

def validate_required_fields(spec):
    """Validate required OpenAPI fields."""
    errors = []
    
    if 'openapi' not in spec and 'swagger' not in spec:
        errors.append("Missing 'openapi' or 'swagger' version")
    
    if 'info' not in spec:
        errors.append("Missing 'info' object")
    else:
        if 'title' not in spec['info']:
            errors.append("Missing 'info.title'")
        if 'version' not in spec['info']:
            errors.append("Missing 'info.version'")
    
    if 'paths' not in spec:
        errors.append("Missing 'paths' object")
    
    return errors

def validate_endpoints(spec):
    """Validate API endpoints."""
    warnings = []
    
    if 'paths' not in spec:
        return warnings
    
    for path, methods in spec['paths'].items():
        for method in methods:
            if method not in ['get', 'post', 'put', 'patch', 'delete', 'options', 'head']:
                continue
            
            operation = methods[method]
            
            # Check for operationId
            if 'operationId' not in operation:
                warnings.append(f"{method.upper()} {path}: Missing 'operationId'")
            
            # Check for responses
            if 'responses' not in operation:
                warnings.append(f"{method.upper()} {path}: Missing 'responses'")
            
            # Check for tags
            if 'tags' not in operation:
                warnings.append(f"{method.upper()} {path}: Missing 'tags'")
    
    return warnings

def validate_security(spec):
    """Validate security definitions."""
    warnings = []
    
    if 'components' in spec and 'securitySchemes' in spec['components']:
        for scheme_name, scheme in spec['components']['securitySchemes'].items():
            if 'type' not in scheme:
                warnings.append(f"Security scheme '{scheme_name}': Missing 'type'")
    
    return warnings

def main():
    if len(sys.argv) < 2:
        print("Usage: validate_openapi.py <openapi-spec-file>")
        return 1
    
    file_path = sys.argv[1]
    print(f"🔍 Validating OpenAPI spec: {file_path}\n")
    
    spec = load_spec(file_path)
    if spec is None:
        return 1
    
    # Validate required fields
    errors = validate_required_fields(spec)
    if errors:
        print("❌ Required field errors:")
        for error in errors:
            print(f"  - {error}")
        return 1
    
    print("✅ Required fields OK")
    
    # Validate endpoints
    warnings = validate_endpoints(spec)
    if warnings:
        print("\n⚠️  Endpoint warnings:")
        for warning in warnings:
            print(f"  - {warning}")
    else:
        print("✅ Endpoints OK")
    
    # Validate security
    security_warnings = validate_security(spec)
    if security_warnings:
        print("\n⚠️  Security warnings:")
        for warning in security_warnings:
            print(f"  - {warning}")
    else:
        print("✅ Security OK")
    
    # Summary
    print("\n📊 Summary:")
    print(f"  - Paths: {len(spec.get('paths', {}))}")
    print(f"  - Components: {len(spec.get('components', {}))}")
    print(f"  - Security schemes: {len(spec.get('components', {}).get('securitySchemes', {}))}")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
