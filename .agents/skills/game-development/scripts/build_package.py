#!/usr/bin/env python3
"""
Build executable for game using pyinstaller.
Supports Python games (tkinter, pygame) and creates standalone executables.
"""

import os
import sys
import subprocess
import argparse
from pathlib import Path

def build_with_pyinstaller(script_path, output_dir="dist", one_file=True, windowed=False):
    """Build executable using pyinstaller."""
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--distpath", output_dir,
    ]
    
    if one_file:
        cmd.append("--onefile")
    
    if windowed:
        cmd.append("--windowed")
    
    # Add icon if exists
    icon_path = Path(script_path).parent / "icon.ico"
    if icon_path.exists():
        cmd.extend(["--icon", str(icon_path)])
    
    # Add data files if they exist
    assets_dir = Path(script_path).parent / "assets"
    if assets_dir.exists():
        cmd.extend(["--add-data", f"{assets_dir}:assets"])
    
    cmd.append(str(script_path))
    
    print(f"🔨 Building executable: {' '.join(cmd)}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    
    if result.returncode != 0:
        print(f"❌ Build failed:\n{result.stderr}")
        return False
    
    print(f"✅ Build successful! Output in {output_dir}/")
    return True

def build_with_cx_freeze(script_path, output_dir="dist"):
    """Build executable using cx_Freeze (alternative)."""
    try:
        from cx_Freeze import setup, Executable
        
        setup(
            name="Game",
            version="1.0.0",
            description="Game Application",
            executables=[Executable(script_path)],
            options={
                "build_exe": {
                    "build_exe": output_dir,
                }
            }
        )
        return True
    except ImportError:
        print("❌ cx_Freeze not installed. Install: pip install cx_Freeze")
        return False

def main():
    parser = argparse.ArgumentParser(description="Build game executable")
    parser.add_argument("script", help="Python script to build")
    parser.add_argument("--output", "-o", default="dist", help="Output directory")
    parser.add_argument("--one-file", action="store_true", default=True, help="Build as single file")
    parser.add_argument("--windowed", "-w", action="store_true", help="Build as windowed app (no console)")
    parser.add_argument("--method", choices=["pyinstaller", "cx_freeze"], default="pyinstaller", help="Build method")
    
    args = parser.parse_args()
    
    if not os.path.exists(args.script):
        print(f"❌ Script not found: {args.script}")
        return 1
    
    print(f"📦 Building {args.script}...\n")
    
    if args.method == "pyinstaller":
        success = build_with_pyinstaller(args.script, args.output, args.one_file, args.windowed)
    else:
        success = build_with_cx_freeze(args.script, args.output)
    
    return 0 if success else 1

if __name__ == "__main__":
    sys.exit(main())
