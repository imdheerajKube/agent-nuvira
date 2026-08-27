#!/usr/bin/env python3
"""
Validate database migration.
Checks for common issues like data loss, backward compatibility, etc.
"""

import sys
import re
from pathlib import Path

def validate_migration(file_path):
    """Validate a SQL migration file."""
    errors = []
    warnings = []
    
    with open(file_path) as f:
        content = f.read()
    
    lines = content.split('\n')
    
    for i, line in enumerate(lines, 1):
        line = line.strip()
        
        # Check for DROP TABLE without IF EXISTS
        if re.match(r'DROP\s+TABLE', line, re.IGNORECASE):
            if 'IF EXISTS' not in line:
                errors.append(f"Line {i}: DROP TABLE without IF EXISTS")
        
        # Check for DROP COLUMN
        if re.match(r'ALTER\s+TABLE.*DROP\s+COLUMN', line, re.IGNORECASE):
            warnings.append(f"Line {i}: DROP COLUMN (potential data loss)")
        
        # Check for TRUNCATE
        if re.match(r'TRUNCATE', line, re.IGNORECASE):
            warnings.append(f"Line {i}: TRUNCATE (data will be lost)")
        
        # Check for DELETE without WHERE
        if re.match(r'DELETE\s+FROM', line, re.IGNORECASE):
            if 'WHERE' not in line:
                warnings.append(f"Line {i}: DELETE without WHERE clause")
    
    return errors, warnings

def main():
    if len(sys.argv) < 2:
        print("Usage: validate_migration.py <migration-file.sql>")
        return 1
    
    file_path = sys.argv[1]
    print(f"🔍 Validating migration: {file_path}\n")
    
    if not Path(file_path).exists():
        print(f"❌ File not found: {file_path}")
        return 1
    
    errors, warnings = validate_migration(file_path)
    
    if errors:
        print("❌ Errors:")
        for error in errors:
            print(f"  - {error}")
        return 1
    
    if warnings:
        print("⚠️  Warnings:")
        for warning in warnings:
            print(f"  - {warning}")
    else:
        print("✅ No issues found")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
