#!/usr/bin/env python3
"""
Validate OpenAPI specification.
Checks for required fields, valid schema, and best practices.
"""

import json
import sys
import yaml
from pathlib import Path

def load_spec(file_path):
    """Load OpenAPI spec from file."""
    path = Path(file_path)
    if not path.exists():
        print(f"❌ File not found: {file_path}")
        return None
    
    with open(path) as f:
        if path.suffix in ['.yaml', '.yml']:
            return yaml.safe_load(f)
        else:
            return json.load(f)

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
