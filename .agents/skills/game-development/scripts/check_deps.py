#!/usr/bin/env python3
"""
Check dependencies for game development.
Verifies Python, tkinter, and optional packages are installed.
"""

import sys
import subprocess
import importlib.util

def check_python():
    """Check Python version."""
    version = sys.version_info
    print(f"Python {version.major}.{version.minor}.{version.micro}")
    if version.major < 3 or (version.major == 3 and version.minor < 8):
        print("  ⚠️  Python 3.8+ recommended")
        return False
    print("  ✅ Python version OK")
    return True

def check_tkinter():
    """Check if tkinter is available."""
    try:
        import tkinter
        print("  ✅ tkinter available")
        return True
    except ImportError:
        print("  ❌ tkinter not available")
        print("     Install: sudo apt-get install python3-tk (Linux)")
        print("             brew install python-tk (macOS)")
        return False

def check_pygame():
    """Check if pygame is available (optional)."""
    try:
        import pygame
        print(f"  ✅ pygame {pygame.version.ver} available")
        return True
    except ImportError:
        print("  ⚠️  pygame not installed (optional)")
        print("     Install: pip install pygame")
        return False

def check_pyinstaller():
    """Check if pyinstaller is available (optional)."""
    try:
        import PyInstaller
        print(f"  ✅ pyinstaller available")
        return True
    except ImportError:
        print("  ⚠️  pyinstaller not installed (optional)")
        print("     Install: pip install pyinstaller")
        return False

def main():
    print("🔍 Checking game development dependencies...\n")
    
    results = {
        "Python": check_python(),
        "tkinter": check_tkinter(),
        "pygame": check_pygame(),
        "pyinstaller": check_pyinstaller(),
    }
    
    print("\n📊 Summary:")
    all_ok = all(results.values())
    required_ok = results["Python"] and results["tkinter"]
    
    if required_ok:
        print("  ✅ Required dependencies OK")
    else:
        print("  ❌ Missing required dependencies")
        return 1
    
    if all_ok:
        print("  ✅ All dependencies OK")
    else:
        print("  ⚠️  Some optional dependencies missing")
    
    return 0

if __name__ == "__main__":
    sys.exit(main())
