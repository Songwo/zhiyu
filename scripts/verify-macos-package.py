"""在 macOS runner 上核对 .app 和 ZIP 的版本、资源与 Mach-O 架构。"""
import argparse
import json
import os
import plistlib
import struct
import zipfile
from pathlib import Path


def verify_parts(info, header, resource_size, executable_mode, version, arch):
    expected = {"arm64": 0x0100000C, "x64": 0x01000007}[arch]
    if info.get("CFBundleShortVersionString") != version or info.get("CFBundleExecutable") != "Zhiyu":
        raise ValueError("macOS 应用版本或可执行名称不匹配")
    if header[:4] != bytes.fromhex("cffaedfe") or len(header) < 8 or struct.unpack("<I", header[4:8])[0] != expected:
        raise ValueError("macOS Mach-O 芯片架构不匹配")
    if resource_size <= 100000 or not executable_mode:
        raise ValueError("macOS 应用资源缺失或没有执行权限")


def verify_app(path, version, arch):
    base = Path(path) / "Contents"
    with (base / "Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    with (base / "MacOS/Zhiyu").open("rb") as stream:
        header = stream.read(32)
    verify_parts(info, header, (base / "Resources/app.asar").stat().st_size,
                 os.access(base / "MacOS/Zhiyu", os.X_OK), version, arch)


def verify_zip(path, version, arch):
    with zipfile.ZipFile(path) as archive:
        for entry in archive.infolist():
            if entry.filename.startswith("/") or ".." in Path(entry.filename).parts:
                raise ValueError("macOS 归档包含路径穿越")
        info = plistlib.loads(archive.read("Zhiyu.app/Contents/Info.plist"))
        entry = archive.getinfo("Zhiyu.app/Contents/MacOS/Zhiyu")
        with archive.open(entry) as stream:
            header = stream.read(32)
        verify_parts(info, header, archive.getinfo("Zhiyu.app/Contents/Resources/app.asar").file_size,
                     (entry.external_attr >> 16) & 0o111, version, arch)
        if archive.testzip() is not None:
            raise ValueError("macOS ZIP 完整性校验失败")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--app")
    parser.add_argument("--zip")
    parser.add_argument("--version", required=True)
    parser.add_argument("--arch", required=True, choices=["arm64", "x64"])
    args = parser.parse_args()
    if not args.app and not args.zip:
        parser.error("需要 --app 或 --zip")
    if args.app:
        verify_app(args.app, args.version, args.arch)
    if args.zip:
        verify_zip(args.zip, args.version, args.arch)
    print(json.dumps({"verified": True, "version": args.version, "architecture": args.arch}))
